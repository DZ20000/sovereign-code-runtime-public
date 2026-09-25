import { readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeFile,
  readGitSource,
  readProductMetadata,
  writeJsonAtomic,
} from "./release-metadata.mjs";
import {
  INSTALLER_PACKAGE_SCHEMA_VERSION,
  verifyInstallerPackage,
} from "./installer-package.mjs";
import { extractNsisPayloadDescriptor } from "./nsis-payload.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const releaseExecutable = resolve(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "sovereign-desktop-tauri.exe",
);
const installerRoot = resolve(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
);
const manifestPath = resolve(installerRoot, "installer-package.json");

async function requireRegularFile(path, label) {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
  return info;
}

await requireRegularFile(releaseExecutable, "Tauri release executable");
const installerEntries = (await readdir(installerRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /_x64-setup\.exe$/u.test(entry.name));
if (installerEntries.length !== 1) {
  throw new Error(
    `Expected exactly one x64 NSIS installer in ${installerRoot}, found ${installerEntries.length}.`,
  );
}
const installerName = installerEntries[0].name;
const installerPath = resolve(installerRoot, installerName);
await requireRegularFile(installerPath, "NSIS installer");

const [source, product, installer, releaseExecutableDescriptor, installedExecutable] = await Promise.all([
  readGitSource(workspaceRoot),
  readProductMetadata(workspaceRoot, projectRoot),
  describeFile(installerPath, installerName),
  describeFile(releaseExecutable, "sovereign-desktop-tauri.exe"),
  extractNsisPayloadDescriptor({
    installerPath,
    payloadPath: "sovereign-desktop-tauri.exe",
  }),
]);
if (source.dirty && process.env.SCR_REQUIRE_CLEAN_PACKAGE === "1") {
  throw new Error(
    `Installer packaging requires a clean Git worktree, but ${source.changeCount} change(s) are present.`,
  );
}

const manifest = {
  schemaVersion: INSTALLER_PACKAGE_SCHEMA_VERSION,
  createdAt: new Date().toISOString(),
  product,
  source,
  installer,
  installedExecutable,
};
await writeJsonAtomic(manifestPath, manifest);
const verification = await verifyInstallerPackage(manifestPath);
if (!verification.passed) {
  throw new Error(
    `Generated installer package failed verification: ${verification.problems.join("; ")}`,
  );
}

console.log(JSON.stringify({
  packaged: true,
  manifestPath,
  manifestSha256: verification.manifestSha256,
  installerPath: verification.installerPath,
  installerSha256: verification.manifest.installer.sha256,
  installedExecutableSha256: verification.manifest.installedExecutable.sha256,
  releaseExecutableSha256: releaseExecutableDescriptor.sha256,
  releaseExecutableMatchesPayload:
    releaseExecutableDescriptor.bytes === installedExecutable.bytes &&
    releaseExecutableDescriptor.sha256 === installedExecutable.sha256,
  sourceCommit: source.commit,
  sourceDirty: source.dirty,
  productVersion: product.version,
}, null, 2));
