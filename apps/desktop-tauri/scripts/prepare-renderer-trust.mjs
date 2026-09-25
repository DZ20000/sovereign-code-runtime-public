import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
  parseRendererTrustedKeyRegistry,
} from "@sovereign/update-core";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = resolve(
  projectRoot,
  "runtime-resources",
  "renderer-trusted-keys.json",
);
const MAX_REGISTRY_BYTES = 256 * 1024;

function nodeErrorCode(error) {
  return error !== null &&
    typeof error === "object" &&
    typeof error.code === "string"
    ? error.code
    : null;
}

async function readBoundedRegularFile(path, label) {
  const info = await lstat(path).catch((error) => {
    throw new Error(`Could not inspect ${label}: ${error.message}`);
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a direct regular file.`);
  }
  if (info.size < 1 || info.size > MAX_REGISTRY_BYTES) {
    throw new Error(
      `${label} is empty or exceeds ${MAX_REGISTRY_BYTES} bytes.`,
    );
  }
  const bytes = await readFile(path);
  if (bytes.length !== info.size) {
    throw new Error(`${label} changed while it was being read.`);
  }
  return bytes;
}

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${path}.${process.pid}.${Date.now()}.bak`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(text, { encoding: "utf8" });
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    return;
  } catch (error) {
    if (!["EEXIST", "EPERM", "EACCES"].includes(nodeErrorCode(error))) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  let movedCurrent = false;
  try {
    const current = await stat(path).catch((error) => {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (current !== null) {
      await rename(path, backup);
      movedCurrent = true;
    }
    await rename(temporary, path);
    if (movedCurrent) await rm(backup, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (movedCurrent) {
      const outputExists = await stat(path)
        .then(() => true)
        .catch(() => false);
      const backupExists = await stat(backup)
        .then(() => true)
        .catch(() => false);
      if (!outputExists && backupExists) {
        await rename(backup, path).catch(() => undefined);
      }
    }
    throw error;
  }
}

function parseArguments(argv) {
  const values = new Map();
  let allowDisabled = false;
  let requireEnabled = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-disabled") {
      allowDisabled = true;
      continue;
    }
    if (argument === "--require-enabled") {
      requireEnabled = true;
      continue;
    }
    if (argument !== "--source" && argument !== "--output") {
      throw new Error(`Unknown renderer trust argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Renderer trust argument requires a value: ${argument}`);
    }
    if (values.has(argument)) {
      throw new Error(
        `Renderer trust argument was provided twice: ${argument}`,
      );
    }
    values.set(argument, value);
    index += 1;
  }
  if (allowDisabled && requireEnabled) {
    throw new Error(
      "Renderer trust preparation cannot both allow and require disabled trust.",
    );
  }
  return {
    source:
      values.get("--source") ??
      process.env.SCR_RENDERER_TRUSTED_KEYS_PATH ??
      null,
    output: values.get("--output") ?? defaultOutput,
    allowDisabled:
      allowDisabled || process.env.SCR_RENDERER_UPDATES_DISABLED === "1",
    requireEnabled,
  };
}

export async function prepareRendererTrust(input = {}) {
  const output = resolve(input.output ?? defaultOutput);
  const sourceValue = input.source ?? null;
  const allowDisabled = input.allowDisabled === true;
  const requireEnabled = input.requireEnabled === true;
  if (allowDisabled && requireEnabled) {
    throw new Error("Renderer trust preparation policy is contradictory.");
  }

  let registry;
  let source = null;
  if (sourceValue === null) {
    if (!allowDisabled) {
      throw new Error(
        "Renderer trusted-key source is required. Use --allow-disabled only for an explicitly disabled development build.",
      );
    }
    registry = {
      schemaVersion: RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
      keys: [],
    };
  } else {
    source = resolve(sourceValue);
    const bytes = await readBoundedRegularFile(
      source,
      "Renderer trusted-key registry",
    );
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(
        `Renderer trusted-key registry is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    registry = parseRendererTrustedKeyRegistry(value);
  }

  if (requireEnabled && registry.keys.length === 0) {
    throw new Error(
      "Release renderer trust preparation requires at least one trusted Ed25519 public key.",
    );
  }
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error(
      "Canonical renderer trusted-key registry exceeds its size limit.",
    );
  }
  await writeAtomic(output, serialized);

  const verified = parseRendererTrustedKeyRegistry(
    JSON.parse(
      (
        await readBoundedRegularFile(output, "Prepared renderer trust registry")
      ).toString("utf8"),
    ),
  );
  return {
    schemaVersion: "scr.renderer-trust-preparation/v1",
    enabled: verified.keys.length > 0,
    source,
    output,
    keyCount: verified.keys.length,
    keys: verified.keys.map((key) => ({
      keyId: key.keyId,
      minimumReleaseSequence: key.minimumReleaseSequence,
      maximumReleaseSequence: key.maximumReleaseSequence,
      allowedChannels: key.allowedChannels,
    })),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const result = await prepareRendererTrust(
    parseArguments(process.argv.slice(2)),
  );
  console.log(JSON.stringify(result, null, 2));
}
