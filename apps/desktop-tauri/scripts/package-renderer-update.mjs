import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RENDERER_SIGNATURE_SCHEMA_VERSION,
  canonicalRendererJson,
  createRendererReleaseManifest,
  parseRendererTrustedKeyRegistry,
  rendererManifestDigest,
  rendererSha256,
  rendererSignaturePayload,
  validateRendererComponentPath,
  verifyRendererInventory,
  verifySignedRendererReleaseEnvelope,
} from "@sovereign/update-core";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const defaultDistRoot = resolve(projectRoot, "dist");
const defaultArtifactsRoot = resolve(projectRoot, "artifacts", "renderer-updates");

const MAX_COMPONENTS = 256;
const MAX_COMPONENT_BYTES = 32 * 1024 * 1024;
const MAX_RENDERER_BYTES = 256 * 1024 * 1024;

function requiredText(value, label, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new Error(`${label} is missing, invalid, or exceeds its length limit.`);
  }
  return value;
}

function requiredInteger(value, label, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function assertContained(root, candidate, label) {
  const rootAbsolute = resolve(root);
  const candidateAbsolute = resolve(candidate);
  const fromRoot = relative(rootAbsolute, candidateAbsolute);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} is outside its expected root.`);
  }
  return candidateAbsolute;
}

function pathIsInside(root, candidate) {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

async function readSigningPrivateKey(pathValue) {
  const path = resolve(
    requiredText(pathValue, "Renderer signing private-key path", 4_096),
  );
  if (pathIsInside(workspaceRoot, path)) {
    throw new Error(
      "Renderer signing private key must remain outside the source workspace.",
    );
  }
  const info = await lstat(path).catch(() => null);
  if (
    info === null ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 1 ||
    info.size > 64 * 1_024 ||
    info.nlink !== 1
  ) {
    throw new Error(
      "Renderer signing private key must be one bounded, direct, unlinked regular file.",
    );
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(
      "Renderer signing private key must not be readable or writable by group or other users.",
    );
  }
  const realWorkspace = await realpath(workspaceRoot);
  const realKey = await realpath(path);
  if (pathIsInside(realWorkspace, realKey)) {
    throw new Error(
      "Renderer signing private key resolves inside the source workspace.",
    );
  }
  const bytes = await readFile(realKey);
  try {
    return loadSigningKey(bytes);
  } finally {
    bytes.fill(0);
  }
}

function normalizeRelative(root, path) {
  const fromRoot = relative(root, path);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Renderer component escaped its source root: ${path}`);
  }
  return validateRendererComponentPath(fromRoot.split(sep).join("/"));
}

async function enumerateRendererFiles(root) {
  const rootInfo = await lstat(root).catch(() => null);
  if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Renderer distribution root is missing or not a direct directory: ${root}`);
  }
  const canonicalRoot = await realpath(root);
  const files = [];
  const stack = [root];
  let directoryCount = 0;
  while (stack.length > 0) {
    const directory = stack.pop();
    directoryCount += 1;
    if (directoryCount > MAX_COMPONENTS * 4) {
      throw new Error("Renderer distribution contains too many directories.");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = assertContained(root, resolve(directory, entry.name), "Renderer entry");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`Renderer distribution contains a symbolic link: ${absolute}`);
      }
      const canonical = await realpath(absolute);
      const canonicalRelative = relative(canonicalRoot, canonical);
      if (
        canonicalRelative === "" ||
        canonicalRelative === ".." ||
        canonicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(canonicalRelative)
      ) {
        throw new Error(`Renderer distribution entry resolves outside its root: ${absolute}`);
      }
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        if (files.length >= MAX_COMPONENTS) {
          throw new Error(`Renderer distribution exceeds ${MAX_COMPONENTS} files.`);
        }
        files.push({
          absolute,
          path: normalizeRelative(root, absolute),
          bytes: info.size,
        });
      } else {
        throw new Error(`Renderer distribution contains an unsupported entry: ${absolute}`);
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) {
    throw new Error("Renderer distribution is empty.");
  }
  return files;
}

async function snapshotRendererComponents(distRoot) {
  const files = await enumerateRendererFiles(distRoot);
  const components = [];
  const payloads = [];
  let totalBytes = 0;
  for (const file of files) {
    if (file.bytes < 1 || file.bytes > MAX_COMPONENT_BYTES) {
      throw new Error(`Renderer component has an invalid byte length: ${file.path}`);
    }
    const bytes = await readFile(file.absolute);
    if (bytes.length !== file.bytes) {
      throw new Error(`Renderer component changed while being packaged: ${file.path}`);
    }
    totalBytes += bytes.length;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RENDERER_BYTES) {
      throw new Error("Renderer distribution exceeds its total byte limit.");
    }
    components.push({
      path: file.path,
      bytes: bytes.length,
      sha256: rendererSha256(bytes),
    });
    payloads.push({ path: file.path, bytes });
  }
  return { components, payloads, totalBytes };
}

async function writeRendererBundle(root, payloads) {
  const bundleRoot = resolve(root, "bundle");
  await mkdir(bundleRoot, { recursive: false });
  for (const payload of payloads) {
    const destination = resolve(bundleRoot, ...payload.path.split("/"));
    assertContained(bundleRoot, destination, "Renderer bundle component");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, payload.bytes, { flag: "wx" });
  }
  return bundleRoot;
}

async function observeBundle(bundleRoot, components) {
  const observed = [];
  for (const component of components) {
    const path = resolve(bundleRoot, ...component.path.split("/"));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Packaged renderer component is not a direct regular file: ${component.path}`);
    }
    const bytes = await readFile(path);
    observed.push({
      path: component.path,
      bytes: bytes.length,
      sha256: rendererSha256(bytes),
    });
  }
  verifyRendererInventory(
    createRendererReleaseManifest({
      releaseId: "inventory-check",
      releaseSequence: 1,
      version: "0.0.1",
      channel: "development",
      createdAt: "2000-01-01T00:00:00.000Z",
      components,
      minimumShellVersion: "0.0.1",
      maximumShellVersion: null,
      bridgeApiVersion: 1,
    }),
    observed,
  );
  return observed;
}

function loadSigningKey(privateKeyBytes) {
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyBytes);
  } catch {
    throw new Error(
      "Renderer signing input must contain one valid private key in PEM or DER form.",
    );
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Renderer signing key must be Ed25519.");
  }
  return privateKey;
}

async function loadTrustedKeys(path) {
  if (path === null) {
    return null;
  }
  const value = JSON.parse(await readFile(path, "utf8"));
  return parseRendererTrustedKeyRegistry(value).keys;
}

async function assertReplaceableRendererPackage(
  outputRoot,
  releaseId,
  verificationKeys,
) {
  const rootInfo = await lstat(outputRoot).catch(() => null);
  if (
    rootInfo === null ||
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink()
  ) {
    throw new Error(
      "Renderer --replace target must be an existing direct package directory.",
    );
  }
  const entries = await readdir(outputRoot, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== 2 ||
    names[0] !== "bundle" ||
    names[1] !== "envelope.json"
  ) {
    throw new Error(
      "Renderer --replace target must contain only bundle/ and envelope.json.",
    );
  }
  const bundleEntry = entries.find((entry) => entry.name === "bundle");
  const envelopeEntry = entries.find((entry) => entry.name === "envelope.json");
  if (
    bundleEntry?.isDirectory() !== true ||
    bundleEntry.isSymbolicLink() ||
    envelopeEntry?.isFile() !== true ||
    envelopeEntry.isSymbolicLink()
  ) {
    throw new Error("Renderer --replace target has an unsafe package shape.");
  }
  const envelopePath = resolve(outputRoot, "envelope.json");
  const envelopeInfo = await lstat(envelopePath);
  if (envelopeInfo.size < 1 || envelopeInfo.size > 512 * 1_024) {
    throw new Error("Renderer --replace target envelope exceeds its size limit.");
  }
  const existingEnvelope = JSON.parse(await readFile(envelopePath, "utf8"));
  const verified = verifySignedRendererReleaseEnvelope(
    existingEnvelope,
    verificationKeys,
  );
  if (verified.envelope.manifest.releaseId !== releaseId) {
    throw new Error(
      "Renderer --replace target release ID does not match the requested package.",
    );
  }
}

export async function packageRendererUpdate(input) {
  const releaseId = requiredText(input.releaseId, "Renderer release ID", 128);
  const releaseSequence = requiredInteger(input.releaseSequence, "Renderer release sequence");
  const keyId = requiredText(input.keyId, "Renderer signing key ID", 128);
  const version = requiredText(input.version, "Renderer version", 64);
  const channel = input.channel ?? "stable";
  const createdAt = input.createdAt ?? new Date().toISOString();
  const minimumShellVersion = requiredText(
    input.minimumShellVersion,
    "Minimum shell version",
    64,
  );
  const maximumShellVersion = input.maximumShellVersion ?? null;
  const bridgeApiVersion = requiredInteger(
    input.bridgeApiVersion ?? 1,
    "Renderer bridge API version",
    1,
    1_000_000,
  );
  const distRoot = resolve(input.distRoot ?? defaultDistRoot);
  const outputRoot = resolve(
    input.outputRoot ?? resolve(defaultArtifactsRoot, releaseId),
  );
  if (basename(outputRoot) !== releaseId) {
    throw new Error(
      "Renderer package output directory name must match the signed release ID.",
    );
  }
  const fromDist = relative(distRoot, outputRoot);
  const fromOutput = relative(outputRoot, distRoot);
  if (
    fromDist === "" ||
    (!fromDist.startsWith(`..${sep}`) && fromDist !== ".." && !isAbsolute(fromDist)) ||
    (!fromOutput.startsWith(`..${sep}`) && fromOutput !== ".." && !isAbsolute(fromOutput))
  ) {
    throw new Error("Renderer distribution and output directories may not contain each other.");
  }

  const privateKey = await readSigningPrivateKey(input.privateKeyPath);
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  const trustedKeys = await loadTrustedKeys(
    input.trustedKeysPath === undefined || input.trustedKeysPath === null
      ? null
      : resolve(input.trustedKeysPath),
  );
  const verificationKeys = trustedKeys ?? [
    {
      keyId,
      algorithm: "ed25519",
      publicKeyPem,
      minimumReleaseSequence: releaseSequence,
      maximumReleaseSequence: releaseSequence,
      allowedChannels: [channel],
    },
  ];

  const { components, payloads, totalBytes } = await snapshotRendererComponents(distRoot);
  const manifest = createRendererReleaseManifest({
    releaseId,
    releaseSequence,
    version,
    channel,
    createdAt,
    components,
    minimumShellVersion,
    maximumShellVersion,
    bridgeApiVersion,
  });
  if (manifest.totalBytes !== totalBytes) {
    throw new Error("Renderer package byte total changed during manifest creation.");
  }
  const manifestSha256 = rendererManifestDigest(manifest);
  const signature = sign(
    null,
    rendererSignaturePayload(manifestSha256),
    privateKey,
  ).toString("base64url");
  const envelope = {
    schemaVersion: RENDERER_SIGNATURE_SCHEMA_VERSION,
    algorithm: "ed25519",
    keyId,
    manifestSha256,
    signature,
    manifest,
  };
  verifySignedRendererReleaseEnvelope(envelope, verificationKeys);

  await mkdir(dirname(outputRoot), { recursive: true });
  const outputExists = await stat(outputRoot).then(() => true).catch(() => false);
  if (outputExists && input.replace !== true) {
    throw new Error(`Renderer package output already exists: ${outputRoot}`);
  }
  const stagingRoot = resolve(
    dirname(outputRoot),
    `.renderer-package-${releaseId}-${process.pid}-${randomBytes(16).toString("hex")}`,
  );
  await mkdir(stagingRoot, { recursive: false });
  try {
    const bundleRoot = await writeRendererBundle(stagingRoot, payloads);
    const observed = await observeBundle(bundleRoot, components);
    verifyRendererInventory(manifest, observed);
    await writeFile(
      resolve(stagingRoot, "envelope.json"),
      `${JSON.stringify(envelope, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    const envelopeAfter = JSON.parse(
      await readFile(resolve(stagingRoot, "envelope.json"), "utf8"),
    );
    verifySignedRendererReleaseEnvelope(envelopeAfter, verificationKeys);
    if (rendererSha256(canonicalRendererJson(envelopeAfter.manifest)) !== manifestSha256) {
      throw new Error("Packaged renderer manifest changed after it was written.");
    }
    if (outputExists) {
      await assertReplaceableRendererPackage(
        outputRoot,
        releaseId,
        verificationKeys,
      );
      await rm(outputRoot, {
        recursive: true,
        force: false,
        maxRetries: 4,
        retryDelay: 100,
      });
    }
    await rename(stagingRoot, outputRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      .catch(() => undefined);
    throw error;
  }

  return {
    schemaVersion: "scr.renderer-package-result/v1",
    outputRoot,
    bundleRoot: resolve(outputRoot, "bundle"),
    envelopePath: resolve(outputRoot, "envelope.json"),
    releaseId,
    releaseSequence,
    version,
    channel,
    keyId,
    manifestSha256,
    componentCount: components.length,
    totalBytes,
    trustedRegistryVerified: trustedKeys !== null,
  };
}

function parseArguments(argv) {
  const values = new Map();
  let replace = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--replace") {
      replace = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected renderer package argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Renderer package argument requires a value: ${argument}`);
    }
    if (values.has(argument)) {
      throw new Error(`Renderer package argument was provided more than once: ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }
  const allowed = new Set([
    "--dist",
    "--out",
    "--private-key",
    "--trusted-keys",
    "--key-id",
    "--release-id",
    "--sequence",
    "--version",
    "--channel",
    "--created-at",
    "--minimum-shell-version",
    "--maximum-shell-version",
    "--bridge-api-version",
  ]);
  for (const argument of values.keys()) {
    if (!allowed.has(argument)) {
      throw new Error(`Unknown renderer package argument: ${argument}`);
    }
  }
  return {
    distRoot: values.get("--dist") ?? defaultDistRoot,
    outputRoot: values.get("--out"),
    privateKeyPath:
      values.get("--private-key") ?? process.env.SCR_RENDERER_SIGNING_KEY_PATH,
    trustedKeysPath: values.get("--trusted-keys"),
    keyId: values.get("--key-id") ?? process.env.SCR_RENDERER_SIGNING_KEY_ID,
    releaseId: values.get("--release-id"),
    releaseSequence: values.get("--sequence"),
    version: values.get("--version"),
    channel: values.get("--channel") ?? "stable",
    createdAt: values.get("--created-at"),
    minimumShellVersion: values.get("--minimum-shell-version"),
    maximumShellVersion:
      values.get("--maximum-shell-version") === "none"
        ? null
        : values.get("--maximum-shell-version"),
    bridgeApiVersion: values.get("--bridge-api-version") ?? 1,
    replace,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const options = parseArguments(process.argv.slice(2));
  requiredText(options.privateKeyPath, "Renderer signing private-key path", 4_096);
  requiredText(options.keyId, "Renderer signing key ID", 128);
  requiredText(options.releaseId, "Renderer release ID", 128);
  requiredInteger(options.releaseSequence, "Renderer release sequence");
  requiredText(options.version, "Renderer version", 64);
  requiredText(options.minimumShellVersion, "Minimum shell version", 64);
  const result = await packageRendererUpdate(options);
  console.log(JSON.stringify(result, null, 2));
}
