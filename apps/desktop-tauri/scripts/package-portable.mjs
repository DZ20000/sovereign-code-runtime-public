import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeFile,
  readGitSource,
  readProductMetadata,
  verifyPortablePackage,
  writeJsonAtomic,
} from "./release-metadata.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const releaseExecutable = resolve(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "sovereign-desktop-tauri.exe",
);
const runtimeResources = resolve(projectRoot, "runtime-resources");
const runtimeHost = resolve(
  workspaceRoot,
  "apps",
  "runtime-host",
  "dist",
  "bundle",
  "runtime-host.cjs",
);
const nativeAgent = resolve(
  workspaceRoot,
  "apps",
  "desktop",
  "native",
  "bin",
  "SovereignNativeAgent.exe",
);
const artifactsRoot = resolve(projectRoot, "artifacts");
const buildId = `portable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputRoot = resolve(artifactsRoot, buildId);

async function requireFile(path, label) {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
  return info;
}

const nodeSource = resolve(runtimeResources, "node", "node.exe");
const guardianSource = resolve(runtimeResources, "host-guardian.mjs");
const watchdogSource = resolve(runtimeResources, "shell-watchdog.mjs");
const manifestSource = resolve(runtimeResources, "runtime-manifest.json");
const rendererTrustedKeysSource = resolve(
  runtimeResources,
  "renderer-trusted-keys.json",
);
const componentSources = [
  {
    path: "SovereignCodeRuntime.exe",
    source: releaseExecutable,
    label: "Tauri release executable",
  },
  {
    path: "node/node.exe",
    source: nodeSource,
    label: "Staged Node executable",
  },
  {
    path: "host-guardian.mjs",
    source: guardianSource,
    label: "Staged Host Guardian script",
  },
  {
    path: "shell-watchdog.mjs",
    source: watchdogSource,
    label: "Staged shell watchdog script",
  },
  {
    path: "runtime-host.cjs",
    source: runtimeHost,
    label: "Runtime Host bundle",
  },
  {
    path: "runtime-manifest.json",
    source: manifestSource,
    label: "Runtime resource manifest",
  },
  {
    path: "renderer-trusted-keys.json",
    source: rendererTrustedKeysSource,
    label: "Renderer trusted-key registry",
  },
  {
    path: "native/bin/SovereignNativeAgent.exe",
    source: nativeAgent,
    label: "Native agent",
  },
];

await Promise.all(componentSources.map(({ source, label }) => requireFile(source, label)));
const [source, product] = await Promise.all([
  readGitSource(workspaceRoot),
  readProductMetadata(workspaceRoot, projectRoot),
]);
if (source.dirty && process.env.SCR_REQUIRE_CLEAN_PACKAGE === "1") {
  throw new Error(
    `Portable packaging requires a clean Git worktree, but ${source.changeCount} change(s) are present.`,
  );
}

try {
  await mkdir(resolve(outputRoot, "node"), { recursive: true });
  await mkdir(resolve(outputRoot, "native", "bin"), { recursive: true });
  await Promise.all(
    componentSources.map(({ source: componentSource, path }) =>
      copyFile(componentSource, resolve(outputRoot, ...path.split("/"))),
    ),
  );

  const components = [];
  let totalBytes = 0;
  for (const component of componentSources) {
    const description = await describeFile(
      resolve(outputRoot, ...component.path.split("/")),
      component.path,
    );
    components.push(description);
    totalBytes += description.bytes;
  }
  const executable = components.find(
    (component) => component.path === "SovereignCodeRuntime.exe",
  );
  if (executable === undefined) {
    throw new Error("Portable executable metadata was not generated.");
  }

  const runtimeManifest = JSON.parse(await readFile(manifestSource, "utf8"));
  const packageManifest = {
    schemaVersion: "scr.portable-package/v2",
    createdAt: new Date().toISOString(),
    product,
    source,
    executable: {
      path: executable.path,
      bytes: executable.bytes,
      sha256: executable.sha256,
    },
    totalBytes,
    components,
    runtime: runtimeManifest,
  };
  const manifestPath = resolve(outputRoot, "portable-package.json");
  await writeJsonAtomic(manifestPath, packageManifest);

  const verification = await verifyPortablePackage(outputRoot);
  if (!verification.passed) {
    throw new Error(
      `Generated portable package failed verification: ${verification.problems.join("; ")}`,
    );
  }

  await mkdir(artifactsRoot, { recursive: true });
  await writeFile(resolve(artifactsRoot, "latest-portable.txt"), `${outputRoot}\n`, "utf8");
  await writeJsonAtomic(resolve(artifactsRoot, "latest-portable.json"), {
    schemaVersion: "scr.portable-pointer/v1",
    updatedAt: new Date().toISOString(),
    portableRoot: outputRoot,
    manifestPath,
    manifestSha256: verification.manifestSha256,
    sourceCommit: source.commit,
    sourceDirty: source.dirty,
    productVersion: product.version,
  });

  const oldEntries = await readdir(artifactsRoot, { withFileTypes: true });
  const oldPortables = oldEntries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("portable-") &&
        entry.name !== buildId,
    )
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(3);
  for (const entry of oldPortables) {
    await rm(resolve(artifactsRoot, entry.name), {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    }).catch(() => {});
  }

  console.log(outputRoot);
} catch (error) {
  await rm(outputRoot, {
    recursive: true,
    force: true,
    maxRetries: 2,
    retryDelay: 100,
  }).catch(() => {});
  throw error;
}
