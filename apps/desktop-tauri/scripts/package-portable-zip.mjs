import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readGitSource, readProductMetadata, sha256File, verifyPortablePackage } from "./release-metadata.mjs";
import { scanZip } from "../../../scripts/public-source-check.mjs";

const run = promisify(execFile);
export const PORTABLE_COMPONENTS = Object.freeze([
  "SovereignCodeRuntime.exe", "node/node.exe", "host-guardian.mjs", "shell-watchdog.mjs",
  "runtime-host.cjs", "runtime-manifest.json", "renderer-trusted-keys.json",
  "native/bin/SovereignNativeAgent.exe",
]);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "../..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...allowed].sort().join("\0")) {
    throw new Error("Unexpected fields in " + label + ".");
  }
}

export function assertReleasePath(path) {
  if (typeof path !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Unsafe release entry path.");
  }
}

function assertRelativeMetadata(value) {
  if (typeof value === "string" && (/[A-Za-z]:[\\/]|\\\\[^\\]/.test(value)
    || /^(?:\/|file:)/i.test(value))) {
    throw new Error("Absolute local path in release metadata.");
  }
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) assertRelativeMetadata(child);
  }
}

export function validateReleaseManifest(manifest, commit, version) {
  exactKeys(manifest, ["schemaVersion", "createdAt", "product", "source", "executable", "totalBytes", "components", "runtime"], "portable manifest");
  exactKeys(manifest.source, ["commit", "shortCommit", "branch", "committedAt", "dirty", "changeCount"], "source provenance");
  exactKeys(manifest.product, ["name", "version", "identifier", "platform", "architecture"], "product metadata");
  exactKeys(manifest.executable, ["path", "bytes", "sha256"], "executable metadata");
  if (manifest.schemaVersion !== "scr.portable-package/v2" || !/^[a-f0-9]{40}$/.test(commit)
    || manifest.source.commit !== commit || manifest.source.dirty !== false || manifest.source.changeCount !== 0) {
    throw new Error("Release must match the current clean source commit.");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    || manifest.product.version !== version || manifest.product.platform !== "win32"
    || manifest.product.architecture !== "x64" || manifest.executable.path !== "SovereignCodeRuntime.exe") {
    throw new Error("Release product/version/platform does not match Windows x64.");
  }
  const paths = manifest.components.map((component) => {
    exactKeys(component, ["path", "bytes", "sha256"], "component");
    assertReleasePath(component.path);
    return component.path;
  });
  if (paths.sort().join("\0") !== [...PORTABLE_COMPONENTS].sort().join("\0")) {
    throw new Error("Portable components do not match the public release allowlist.");
  }
  exactKeys(manifest.runtime, ["schemaVersion", "generatedAt", "node", "runtimeHost", "hostGuardian",
    "shellWatchdog", "nativeAgent", "tunnelClientBundled"], "runtime metadata");
  const runtimePaths = {
    node: ["executable", "node/node.exe", ["version", "executable", "sha256"]],
    runtimeHost: ["path", "runtime-host.cjs", ["path", "sha256"]],
    hostGuardian: ["path", "host-guardian.mjs", ["path", "sha256", "restartWindowMs", "maximumRestartsPerWindow"]],
    shellWatchdog: ["path", "shell-watchdog.mjs", ["path", "sha256"]],
    nativeAgent: ["path", "native/bin/SovereignNativeAgent.exe", ["path", "sha256"]],
  };
  if (manifest.runtime.schemaVersion !== "scr.runtime-resources/v1" || manifest.runtime.tunnelClientBundled !== false) {
    throw new Error("Unexpected runtime metadata.");
  }
  for (const [key, [field, path, fields]] of Object.entries(runtimePaths)) {
    exactKeys(manifest.runtime[key], fields, "runtime " + key);
    if (manifest.runtime[key][field] !== path
      || manifest.runtime[key].sha256 !== manifest.components.find((entry) => entry.path === path).sha256) {
      throw new Error("Runtime component metadata mismatch: " + key);
    }
  }
  assertRelativeMetadata(manifest);
}

export function privacyValues(root) {
  return [
    root, homedir(), process.env.CARGO_HOME, process.env.GITHUB_WORKSPACE,
    process.env.RUNNER_TEMP, process.env.RUNNER_TOOL_CACHE,
    process.env.COMPUTERNAME, process.env.USERDNSDOMAIN,
  ].filter((value) => typeof value === "string" && value.length >= 5)
    .flatMap((value) => [value, value.replaceAll("\\", "/"), value.replaceAll("\\", "\\\\")]);
}

export function assertPublicBytes(bytes, entry, sensitiveValues = []) {
  for (const value of sensitiveValues) {
    const variants = new Set([value, value.replaceAll("\\", "/"), value.replaceAll("\\", "\\\\")]);
    for (const variant of variants) {
      for (const encoding of ["utf8", "utf16le"]) {
        if (bytes.includes(Buffer.from(variant, encoding))) {
          throw new Error("Private build-machine value detected in " + entry + ".");
        }
      }
    }
  }
  // Match build-agent paths in both text and Windows native binaries.
  const runnerPath = /[A-Za-z]:[\\/]+(?:a|actions-runner|hostedtoolcache)[\\/]|[A-Za-z]:[\\/]+Users[\\/]+(?:runneradmin|runner|VssAdministrator)[\\/]|\/(?:home\/runner|Users\/runner)[\\/]|[\\/]\.(?:cargo|rustup)[\\/](?:registry|toolchains)[\\/]/i;
  if (runnerPath.test(bytes.toString("latin1")) || runnerPath.test(bytes.toString("utf16le"))) {
    throw new Error("Build-agent path detected in " + entry + ".");
  }
}

async function containedFile(root, path) {
  assertReleasePath(path);
  const absolute = resolve(root, ...path.split("/"));
  const info = await lstat(absolute);
  const actualRoot = await realpath(root);
  const actual = await realpath(absolute);
  const child = relative(actualRoot, actual);
  if (!info.isFile() || info.isSymbolicLink() || child === "" || child === ".."
    || child.startsWith(".." + sep) || isAbsolute(child)) {
    throw new Error("Release input is not a contained regular file: " + path);
  }
  return actual;
}

const ZIP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "Add-Type -AssemblyName System.IO.Compression",
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  "$spec = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$stream = [IO.File]::Open($spec.output, [IO.FileMode]::CreateNew)",
  "try {",
  "  $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)",
  "  try { foreach ($file in $spec.files) {",
  "    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.source, $file.path, [IO.Compression.CompressionLevel]::Optimal) | Out-Null",
  "  } } finally { $zip.Dispose() }",
  "} finally { $stream.Dispose() }",
  "$zip = [IO.Compression.ZipFile]::OpenRead($spec.output)",
  "try {",
  "  $rows = @(foreach ($entry in $zip.Entries) {",
  "    $hash = [Security.Cryptography.SHA256]::Create(); $content = $entry.Open()",
  "    try { [pscustomobject]@{ path=$entry.FullName; bytes=$entry.Length; sha256=([BitConverter]::ToString($hash.ComputeHash($content))).Replace('-','').ToLowerInvariant() } }",
  "    finally { $content.Dispose(); $hash.Dispose() }",
  "  }); ConvertTo-Json -InputObject $rows -Compress",
  "} finally { $zip.Dispose() }",
].join("\n");

export async function writeVerifiedZip(files, output, sensitiveValues = []) {
  if (process.platform !== "win32") throw new Error("Portable ZIP creation requires Windows.");
  const seen = new Set();
  const expected = new Map();
  for (const file of files) {
    assertReleasePath(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate release entry.");
    seen.add(key);
    const info = await lstat(file.source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Release input is not a regular file.");
    const bytes = await readFile(file.source);
    assertPublicBytes(bytes, file.path, sensitiveValues);
    expected.set(file.path, { bytes: bytes.length, sha256: digest(bytes) });
  }
  const temporary = output + "." + randomUUID() + ".partial";
  await mkdir(dirname(output), { recursive: true });
  try {
    const powershell = resolve(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const pending = run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ZIP_SCRIPT], {
      encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    pending.child.stdin.end(JSON.stringify({ output: temporary, files }));
    const { stdout } = await pending;
    const actual = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (!Array.isArray(actual) || actual.length !== expected.size) throw new Error("ZIP entry count mismatch.");
    for (const entry of actual) {
      const wanted = expected.get(entry.path);
      if (wanted === undefined || entry.bytes !== wanted.bytes || entry.sha256 !== wanted.sha256) {
        throw new Error("ZIP read-back verification failed.");
      }
      expected.delete(entry.path);
    }
    if (expected.size !== 0) throw new Error("ZIP entries are missing.");
    const privacy = scanZip(await readFile(temporary), { maxBytes: 268435456, denyTerms: sensitiveValues });
    if (privacy.findings.length !== 0) {
      throw new Error("Public archive scan failed: " + JSON.stringify(privacy.findings));
    }
    await copyFile(temporary, output, constants.COPYFILE_EXCL);
    const sha256 = await sha256File(output);
    await writeFile(output + ".sha256", sha256 + "  " + basename(output) + "\n", { encoding: "utf8", flag: "wx" });
    return { filename: basename(output), sha256, bytes: (await lstat(output)).size, entries: actual.length };
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function packagePortableZip() {
  const source = await readGitSource(workspaceRoot);
  if (source.dirty) throw new Error("A public release requires a clean committed source tree.");
  const product = await readProductMetadata(workspaceRoot, projectRoot);
  const pointer = resolve(projectRoot, "artifacts/latest-portable.txt");
  const portableRoot = resolve((await readFile(pointer, "utf8")).trim());
  const manifestPath = await containedFile(portableRoot, "portable-package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateReleaseManifest(manifest, source.commit, product.version);
  const verification = await verifyPortablePackage(portableRoot, manifest);
  if (!verification.passed) throw new Error("Portable component verification failed.");
  const runtime = JSON.parse(await readFile(await containedFile(portableRoot, "runtime-manifest.json"), "utf8"));
  if (JSON.stringify(runtime) !== JSON.stringify(manifest.runtime)) throw new Error("Runtime manifest mismatch.");
  const trust = JSON.parse(await readFile(await containedFile(portableRoot, "renderer-trusted-keys.json"), "utf8"));
  exactKeys(trust, ["schemaVersion", "keys"], "renderer trust");
  if (trust.schemaVersion !== "scr.renderer-trusted-keys/v1" || !Array.isArray(trust.keys) || trust.keys.length !== 0) {
    throw new Error("Public portable releases require the unconfigured renderer trust registry.");
  }
  if (manifest.runtime.node.version !== process.version || await sha256File(process.execPath) !== manifest.runtime.node.sha256) {
    throw new Error("Package Node runtime must match the build toolchain supplying its license.");
  }
  const files = [];
  for (const path of [...PORTABLE_COMPONENTS, "portable-package.json"]) {
    files.push({ path, source: await containedFile(portableRoot, path) });
  }
  const tracked = (await run("git", ["ls-files", "-z", "--", "licenses"], { cwd: workspaceRoot, encoding: "utf8" })).stdout.split("\0").filter(Boolean);
  for (const path of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", ...tracked]) {
    if (path.startsWith("licenses/") && !/^licenses\/(?:dependency-inventory\.json|gradle-wrapper-LICENSE\.txt|third-party\/[a-f0-9]{64}\.txt)$/.test(path)) {
      throw new Error("Unexpected public notice file.");
    }
    files.push({ path, source: await containedFile(workspaceRoot, path) });
  }
  files.push({ path: "README.md", source: await containedFile(workspaceRoot, "docs/windows-portable.md") });
  files.push({ path: "licenses/Node-LICENSE.txt", source: resolve(dirname(process.execPath), "LICENSE") });
  const filename = "SovereignCodeRuntime-" + product.version + "-windows-x64.zip";
  const result = await writeVerifiedZip(files, resolve(projectRoot, "artifacts/release", filename), privacyValues(workspaceRoot));
  console.log(JSON.stringify({ ...result, sourceCommit: source.commit }));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packagePortableZip();
