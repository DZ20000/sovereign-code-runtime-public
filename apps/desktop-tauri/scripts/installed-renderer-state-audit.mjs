import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  parseRendererTrustedKeyRegistry,
  verifyRendererInventory,
  verifySignedRendererReleaseEnvelope,
} from "@sovereign/update-core";

import { verifyInstalledRendererReadyMarker } from "./installed-renderer-ready-marker.mjs";
import {
  MAX_RENDERER_STATE_BYTES,
  MAX_RENDERER_STATE_REVISIONS,
  verifyRendererStateJournal,
} from "./installed-renderer-state-journal.mjs";

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;
const STATE_FILE_PATTERN = /^revision-[0-9]{20}\.json$/u;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_COMPONENT_BYTES = 32 * 1024 * 1024;
const MAX_SLOT_ENTRIES = 4_096;
const MAX_COMPONENT_DIRECTORY_DEPTH = 64;
const RENDERER_METADATA_FILES = new Set(["envelope.json", "ready.json"]);

function strictChild(parent, candidate) {
  const relation = relative(parent, candidate);
  return (
    relation.length > 0 &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function sameResolvedPath(left, right) {
  return (
    resolve(left).toLocaleLowerCase("en-US") ===
    resolve(right).toLocaleLowerCase("en-US")
  );
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function lastKnownGoodProblem(problem) {
  return problem.startsWith("Active Renderer")
    ? problem.replace(/^Active Renderer/u, "Last-known-good Renderer")
    : `Last-known-good Renderer: ${problem}`;
}

async function optionalDirectDirectory(path, parent, label) {
  const info = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a direct directory: ${path}`);
  }
  const [parentReal, pathReal] = await Promise.all([
    realpath(parent),
    realpath(path),
  ]);
  if (!strictChild(parentReal, pathReal)) {
    throw new Error(`${label} resolves outside its expected parent.`);
  }
  return pathReal;
}

async function readDirectFileEvidence(
  path,
  parent,
  label,
  maximumBytes,
  expectedBytes = null,
) {
  const initial = await lstat(path, { bigint: true }).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (initial === null) return null;
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.nlink !== 1n ||
    initial.size > BigInt(maximumBytes)
  ) {
    throw new Error(`${label} must be one bounded direct regular file.`);
  }
  if (expectedBytes !== null && initial.size !== BigInt(expectedBytes)) {
    throw new Error(`${label} byte length does not match its manifest.`);
  }

  const [parentReal, pathReal] = await Promise.all([
    realpath(parent),
    realpath(path),
  ]);
  if (!strictChild(parentReal, pathReal)) {
    throw new Error(`${label} resolves outside its expected parent.`);
  }

  const handle = await open(path, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(initial, opened)) {
      throw new Error(`${label} changed before it was opened.`);
    }
    const content = await handle.readFile();
    const completed = await handle.stat({ bigint: true });
    if (!sameFileIdentity(opened, completed)) {
      throw new Error(`${label} changed while it was read.`);
    }
    const [current, currentParentReal, currentPathReal] = await Promise.all([
      lstat(path, { bigint: true }),
      realpath(parent),
      realpath(path),
    ]);
    if (
      !sameFileIdentity(opened, current) ||
      !sameResolvedPath(parentReal, currentParentReal) ||
      !sameResolvedPath(pathReal, currentPathReal)
    ) {
      throw new Error(`${label} path changed while it was read.`);
    }
    return Object.freeze({
      content,
      bytes: Number(opened.size),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

async function readDirectJson(path, parent, label) {
  const evidence = await readDirectFileEvidence(
    path,
    parent,
    label,
    MAX_JSON_BYTES,
  );
  if (evidence === null) return null;
  return JSON.parse(evidence.content.toString("utf8"));
}

function normalizedRelease(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !RELEASE_ID_PATTERN.test(value.releaseId ?? "") ||
    !Number.isSafeInteger(value.releaseSequence) ||
    value.releaseSequence < 1 ||
    !VERSION_PATTERN.test(value.version ?? "") ||
    !/^[a-f0-9]{64}$/u.test(value.manifestSha256 ?? "")
  ) {
    return null;
  }
  return Object.freeze({
    releaseId: value.releaseId,
    releaseSequence: value.releaseSequence,
    version: value.version,
    channel: typeof value.channel === "string" ? value.channel : null,
    manifestSha256: value.manifestSha256,
  });
}

function releasesMatch(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.releaseId === right.releaseId &&
    left.releaseSequence === right.releaseSequence &&
    left.version === right.version &&
    left.channel === right.channel &&
    left.manifestSha256 === right.manifestSha256
  );
}

function unavailable(problem) {
  return Object.freeze({
    available: false,
    consistent: false,
    problems: Object.freeze([problem]),
  });
}

function expectedDirectoriesFor(manifest) {
  const directories = new Set();
  for (const component of manifest.components) {
    const segments = component.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

async function inspectRendererInventory(slotRoot, manifest, problems) {
  const problemStart = problems.length;
  const expectedByPath = new Map(
    manifest.components.map((component) => [component.path, component]),
  );
  const expectedDirectories = expectedDirectoriesFor(manifest);
  const presentPaths = new Set();
  const verifiedPaths = new Set();
  const observed = [];
  let visitedEntryCount = 0;

  const visit = async (directory, segments, depth) => {
    if (depth > MAX_COMPONENT_DIRECTORY_DEPTH) {
      throw new Error(
        `Active Renderer slot exceeds ${MAX_COMPONENT_DIRECTORY_DEPTH} directory levels.`,
      );
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (segments.length === 0 && entry.name === ".scr-renderer") {
        continue;
      }
      visitedEntryCount += 1;
      if (visitedEntryCount > MAX_SLOT_ENTRIES) {
        throw new Error(
          `Active Renderer slot exceeds ${MAX_SLOT_ENTRIES} audited entries.`,
        );
      }

      const componentPath = [...segments, entry.name].join("/");
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        problems.push(
          `Active Renderer slot contains a link: ${componentPath}.`,
        );
        continue;
      }
      const info = await lstat(absolutePath, { bigint: true });
      const pathReal = await realpath(absolutePath);
      if (!strictChild(slotRoot, pathReal)) {
        problems.push(
          `Active Renderer component escapes its slot: ${componentPath}.`,
        );
        continue;
      }

      if (info.isDirectory()) {
        if (!expectedDirectories.has(componentPath)) {
          problems.push(
            `Active Renderer slot contains an unmanifested directory: ${componentPath}.`,
          );
          continue;
        }
        await visit(pathReal, [...segments, entry.name], depth + 1);
        continue;
      }
      if (!info.isFile()) {
        problems.push(
          `Active Renderer slot contains a non-regular entry: ${componentPath}.`,
        );
        continue;
      }

      const expected = expectedByPath.get(componentPath);
      if (expected === undefined) {
        problems.push(
          `Active Renderer slot contains an unmanifested component: ${componentPath}.`,
        );
        continue;
      }
      if (presentPaths.has(componentPath)) {
        problems.push(
          `Active Renderer slot duplicates component: ${componentPath}.`,
        );
        continue;
      }
      presentPaths.add(componentPath);
      if (info.nlink !== 1n) {
        problems.push(
          `Active Renderer component is hard-linked: ${componentPath}.`,
        );
        continue;
      }
      if (info.size !== BigInt(expected.bytes)) {
        problems.push(
          `Active Renderer component byte length does not match its manifest: ${componentPath}.`,
        );
        continue;
      }

      try {
        const evidence = await readDirectFileEvidence(
          absolutePath,
          directory,
          `Active Renderer component ${componentPath}`,
          MAX_COMPONENT_BYTES,
          expected.bytes,
        );
        if (evidence === null) {
          problems.push(
            `Active Renderer component is missing: ${componentPath}.`,
          );
          continue;
        }
        observed.push({
          path: componentPath,
          sha256: evidence.sha256,
          bytes: evidence.bytes,
        });
        if (evidence.sha256 === expected.sha256) {
          verifiedPaths.add(componentPath);
        }
      } catch (error) {
        problems.push(errorMessage(error));
      }
    }
  };

  try {
    await visit(slotRoot, [], 0);
  } catch (error) {
    problems.push(
      `Active Renderer inventory scan failed: ${errorMessage(error)}`,
    );
  }
  for (const component of manifest.components) {
    if (!presentPaths.has(component.path)) {
      problems.push(`Active Renderer component is missing: ${component.path}.`);
    }
  }

  let inventoryVerified = false;
  if (problems.length === problemStart) {
    try {
      verifyRendererInventory(manifest, observed);
      inventoryVerified = true;
    } catch (error) {
      problems.push(
        `Active Renderer inventory verification failed: ${errorMessage(error)}`,
      );
    }
  }
  return Object.freeze({
    inventoryVerified,
    componentCount: manifest.components.length,
    verifiedComponentCount: verifiedPaths.size,
    entrypointMatched: verifiedPaths.has(manifest.entrypoint),
  });
}

function emptySlotEvidence(trustedKeysPath) {
  return {
    readyRelease: null,
    readyMarkerVerified: false,
    readyInstalledAtUnixMs: null,
    envelopeRelease: null,
    entrypoint: null,
    entrypointMatched: false,
    trustedKeysPath,
    signingKeyId: null,
    signatureVerified: false,
    inventoryVerified: false,
    componentCount: 0,
    verifiedComponentCount: 0,
  };
}

async function inspectRendererMetadata(metadataRoot, problems) {
  const entries = await readdir(metadataRoot, { withFileTypes: true });
  const names = new Set();
  for (const entry of entries) {
    names.add(entry.name);
    if (!RENDERER_METADATA_FILES.has(entry.name)) {
      problems.push(
        `Active Renderer metadata contains an unexpected entry: ${entry.name}.`,
      );
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      problems.push(
        `Active Renderer metadata is not a direct regular file: ${entry.name}.`,
      );
    }
  }
  for (const expected of RENDERER_METADATA_FILES) {
    if (!names.has(expected)) {
      problems.push(`Active Renderer metadata file is missing: ${expected}.`);
    }
  }
}

async function inspectActiveSlot(options) {
  const { updatesRoot, activeRelease, problems, trustedKeysPath } = options;
  const evidence = emptySlotEvidence(trustedKeysPath);

  const slotsRoot = await optionalDirectDirectory(
    resolve(updatesRoot, "slots"),
    updatesRoot,
    "Renderer slots root",
  );
  if (slotsRoot === null) {
    problems.push("Renderer slots root is missing.");
    return evidence;
  }
  const slotRoot = await optionalDirectDirectory(
    resolve(slotsRoot, activeRelease.releaseId),
    slotsRoot,
    "Active Renderer slot",
  );
  if (slotRoot === null) {
    problems.push("Active Renderer slot is missing.");
    return evidence;
  }
  const metadataRoot = await optionalDirectDirectory(
    resolve(slotRoot, ".scr-renderer"),
    slotRoot,
    "Active Renderer metadata root",
  );
  if (metadataRoot === null) {
    problems.push("Active Renderer metadata root is missing.");
    return evidence;
  }
  await inspectRendererMetadata(metadataRoot, problems);

  const ready = await readDirectJson(
    resolve(metadataRoot, "ready.json"),
    metadataRoot,
    "Active Renderer ready marker",
  );
  const envelope = await readDirectJson(
    resolve(metadataRoot, "envelope.json"),
    metadataRoot,
    "Active Renderer signature envelope",
  );
  if (ready === null) {
    problems.push("Active Renderer ready marker is missing.");
  } else {
    try {
      const verifiedReady = verifyInstalledRendererReadyMarker(ready);
      evidence.readyRelease = verifiedReady.release;
      evidence.readyMarkerVerified = true;
      evidence.readyInstalledAtUnixMs = verifiedReady.installedAtUnixMs;
    } catch (error) {
      problems.push(
        `Active Renderer ready marker is invalid: ${errorMessage(error)}`,
      );
    }
  }
  evidence.envelopeRelease = normalizedRelease(
    envelope?.manifest !== null && typeof envelope?.manifest === "object"
      ? {
          ...envelope.manifest,
          manifestSha256: envelope.manifestSha256,
        }
      : null,
  );
  if (!releasesMatch(activeRelease, evidence.readyRelease)) {
    problems.push("Active Renderer ready marker does not match state.");
  }
  if (!releasesMatch(activeRelease, evidence.envelopeRelease)) {
    problems.push("Active Renderer envelope does not match state.");
  }
  if (envelope?.manifestSha256 !== activeRelease.manifestSha256) {
    problems.push("Active Renderer envelope digest does not match state.");
  }

  let trustedRegistry = null;
  try {
    const trustedRegistryValue = await readDirectJson(
      trustedKeysPath,
      dirname(trustedKeysPath),
      "Installed Renderer trusted-key registry",
    );
    if (trustedRegistryValue === null) {
      problems.push("Installed Renderer trusted-key registry is missing.");
    } else {
      trustedRegistry = parseRendererTrustedKeyRegistry(trustedRegistryValue);
    }
  } catch (error) {
    problems.push(
      `Installed Renderer trusted-key registry is invalid: ${errorMessage(error)}`,
    );
  }

  let verifiedEnvelope = null;
  if (envelope === null) {
    problems.push("Active Renderer signature envelope is missing.");
  } else if (trustedRegistry !== null) {
    try {
      verifiedEnvelope = verifySignedRendererReleaseEnvelope(
        envelope,
        trustedRegistry.keys,
      );
      evidence.signatureVerified = true;
      evidence.signingKeyId = verifiedEnvelope.signingKeyId;
    } catch (error) {
      problems.push(
        `Active Renderer signature verification failed: ${errorMessage(error)}`,
      );
    }
  }
  if (verifiedEnvelope === null) return evidence;

  const manifest = verifiedEnvelope.envelope.manifest;
  evidence.envelopeRelease = normalizedRelease({
    ...manifest,
    manifestSha256: verifiedEnvelope.envelope.manifestSha256,
  });
  evidence.entrypoint = manifest.entrypoint;
  const inventory = await inspectRendererInventory(
    slotRoot,
    manifest,
    problems,
  );
  evidence.inventoryVerified = inventory.inventoryVerified;
  evidence.componentCount = inventory.componentCount;
  evidence.verifiedComponentCount = inventory.verifiedComponentCount;
  evidence.entrypointMatched = inventory.entrypointMatched;
  if (!evidence.entrypointMatched) {
    problems.push(
      "Active Renderer entrypoint digest does not match its manifest.",
    );
  }
  return evidence;
}

export async function readInstalledRendererState(options) {
  if (
    typeof options?.trustedKeysPath !== "string" ||
    options.trustedKeysPath.trim().length === 0 ||
    !isAbsolute(options.trustedKeysPath)
  ) {
    throw new Error(
      "Installed Renderer trusted-key registry path must be absolute.",
    );
  }
  const appData = await realpath(options.appDataPath);
  const trustedKeysPath = resolve(options.trustedKeysPath);
  const identifierRoot = await optionalDirectDirectory(
    resolve(appData, options.identifier),
    appData,
    "Installed application data root",
  );
  if (identifierRoot === null) {
    return unavailable("Installed application data root is missing.");
  }
  const updatesRoot = await optionalDirectDirectory(
    resolve(identifierRoot, "renderer-updates"),
    identifierRoot,
    "Renderer updates root",
  );
  if (updatesRoot === null)
    return unavailable("Renderer updates root is missing.");
  const stateRoot = await optionalDirectDirectory(
    resolve(updatesRoot, "state"),
    updatesRoot,
    "Renderer state root",
  );
  if (stateRoot === null) return unavailable("Renderer state root is missing.");

  const problems = [];
  const stateFiles = [];
  for (const entry of await readdir(stateRoot, { withFileTypes: true })) {
    if (STATE_FILE_PATTERN.test(entry.name)) {
      stateFiles.push(entry.name);
      continue;
    }
    if (entry.name.startsWith(".pending-") && entry.name.endsWith(".tmp")) {
      problems.push(
        `Renderer state root contains an incomplete pending revision: ${entry.name}.`,
      );
    } else {
      problems.push(
        `Renderer state root contains an unexpected entry: ${entry.name}.`,
      );
    }
  }
  stateFiles.sort();
  const latestStateFile = stateFiles.at(-1) ?? null;
  if (latestStateFile === null) {
    return unavailable("Renderer state root contains no revision file.");
  }
  if (stateFiles.length > MAX_RENDERER_STATE_REVISIONS) {
    throw new Error("Renderer state journal contains too many revisions.");
  }

  const journalEntries = [];
  for (const stateFile of stateFiles) {
    const evidence = await readDirectFileEvidence(
      resolve(stateRoot, stateFile),
      stateRoot,
      `Renderer state revision ${stateFile}`,
      MAX_RENDERER_STATE_BYTES,
    );
    if (evidence === null) {
      throw new Error(`Renderer state revision disappeared: ${stateFile}.`);
    }
    journalEntries.push({ fileName: stateFile, content: evidence.content });
  }

  let journal = null;
  try {
    journal = verifyRendererStateJournal(journalEntries);
  } catch (error) {
    problems.push(`Renderer state journal is invalid: ${errorMessage(error)}`);
  }
  const state = journal?.latestState ?? null;
  const activeRelease = normalizedRelease(state?.activeRelease ?? null);

  const slot =
    activeRelease === null
      ? emptySlotEvidence(trustedKeysPath)
      : await inspectActiveSlot({
          updatesRoot,
          activeRelease,
          trustedKeysPath,
          problems,
        });
  const lastKnownGoodRelease = normalizedRelease(
    state?.lastKnownGoodRelease ?? null,
  );
  let lastKnownGoodSlot = null;
  if (lastKnownGoodRelease !== null) {
    const rollbackProblems = [];
    const rollbackEvidence = await inspectActiveSlot({
      updatesRoot,
      activeRelease: lastKnownGoodRelease,
      trustedKeysPath,
      problems: rollbackProblems,
    });
    lastKnownGoodSlot = Object.freeze({
      ...rollbackEvidence,
      verified: rollbackProblems.length === 0,
    });
    problems.push(...rollbackProblems.map(lastKnownGoodProblem));
  }

  return Object.freeze({
    available: true,
    consistent: problems.length === 0,
    stateFile: journal?.latestFileName ?? latestStateFile,
    stateSha256: journal?.latestSha256 ?? null,
    stateJournalVerified: journal !== null,
    stateRevisionCount: journal?.revisionCount ?? stateFiles.length,
    stateJournalBytes:
      journal?.journalBytes ??
      journalEntries.reduce(
        (total, entry) => total + entry.content.byteLength,
        0,
      ),
    storageRevision: state?.storageRevision ?? null,
    updatedAtUnixMs: state?.updatedAtUnixMs ?? null,
    activeRelease,
    readyRelease: slot.readyRelease,
    readyMarkerVerified: slot.readyMarkerVerified,
    readyInstalledAtUnixMs: slot.readyInstalledAtUnixMs,
    envelopeRelease: slot.envelopeRelease,
    highestReleaseSequence: state?.highestReleaseSequence ?? null,
    pendingActivation: null,
    lastFailure: state?.lastFailure ?? null,
    lastKnownGoodRelease,
    lastKnownGoodSlot,
    entrypoint: slot.entrypoint,
    entrypointMatched: slot.entrypointMatched,
    trustedKeysPath: slot.trustedKeysPath,
    signingKeyId: slot.signingKeyId,
    signatureVerified: slot.signatureVerified,
    inventoryVerified: slot.inventoryVerified,
    componentCount: slot.componentCount,
    verifiedComponentCount: slot.verifiedComponentCount,
    problems: Object.freeze(problems),
  });
}
