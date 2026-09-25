#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { verifyRendererStateJournal } from "../apps/desktop-tauri/scripts/installed-renderer-state-journal.mjs";

const LEASE_SCHEMA = "scr.renderer-activation-lease/v1";
const PROVENANCE_SCHEMA = "scr.renderer-release-provenance/v1";
const QUARANTINE_SCHEMA = "scr.renderer-quarantine-receipt/v1";
const STATE_FILE_PATTERN = /^revision-(\d+)\.json$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

function requiredString(value, label, pattern = null) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  const normalized = value.trim();
  if (pattern !== null && !pattern.test(normalized)) {
    throw new Error(`${label} has an invalid format.`);
  }
  return normalized;
}

function requiredInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return normalized;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertDirectChild(parent, child, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error(`${label} must be a direct child of ${parent}.`);
  }
}

export async function readLatestRendererState(stateRoot) {
  const stateDirectory = path.join(path.resolve(stateRoot), "state");
  const entries = await readdir(stateDirectory, { withFileTypes: true });
  const journalEntries = [];
  for (const entry of entries) {
    if (!entry.isFile() || !STATE_FILE_PATTERN.test(entry.name)) {
      throw new Error(
        `Renderer state directory contains an unexpected entry: ${entry.name}.`,
      );
    }
    journalEntries.push({
      fileName: entry.name,
      content: await readFile(path.join(stateDirectory, entry.name)),
    });
  }
  const journal = verifyRendererStateJournal(journalEntries);
  return {
    filePath: path.join(stateDirectory, journal.latestFileName),
    revision: journal.latestState.storageRevision,
    state: journal.latestState,
  };
}

async function readCandidate(candidateDirectory) {
  const envelopePath = path.join(candidateDirectory, "envelope.json");
  const envelope = await readJson(envelopePath);
  const manifest = envelope?.manifest;
  if (envelope?.schemaVersion !== "scr.renderer-release-signature/v1") {
    throw new Error("Candidate envelope schema is not trusted.");
  }
  if (manifest?.schemaVersion !== "scr.renderer-release/v1") {
    throw new Error("Candidate manifest schema is not trusted.");
  }
  const releaseId = requiredString(
    manifest.releaseId,
    "candidate releaseId",
    SAFE_ID_PATTERN,
  );
  if (releaseId !== path.basename(candidateDirectory)) {
    throw new Error("Candidate directory name does not match releaseId.");
  }
  return {
    directory: candidateDirectory,
    envelopePath,
    envelope,
    releaseId,
    releaseSequence: requiredInteger(
      manifest.releaseSequence,
      "candidate releaseSequence",
    ),
    version: requiredString(manifest.version, "candidate version"),
    channel: requiredString(manifest.channel, "candidate channel"),
    manifestSha256: requiredString(
      envelope.manifestSha256,
      "manifestSha256",
      /^[0-9a-f]{64}$/u,
    ),
  };
}

async function listCandidates(stateRoot) {
  const inbox = path.join(path.resolve(stateRoot), "inbox");
  const entries = await readdir(inbox, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(inbox, entry.name);
    if (!(await pathExists(path.join(directory, "envelope.json")))) continue;
    candidates.push(await readCandidate(directory));
  }
  return candidates;
}

function normalizeLeaseOptions(options) {
  const stateRoot = path.resolve(
    requiredString(options.stateRoot, "stateRoot"),
  );
  const candidateDirectory = path.resolve(
    options.candidateDirectory ??
      path.join(
        stateRoot,
        "inbox",
        requiredString(options.releaseId, "releaseId", SAFE_ID_PATTERN),
      ),
  );
  assertDirectChild(
    path.join(stateRoot, "inbox"),
    candidateDirectory,
    "candidateDirectory",
  );
  return {
    stateRoot,
    candidateDirectory,
    originTaskId: requiredString(
      options.originTaskId,
      "originTaskId",
      SAFE_ID_PATTERN,
    ),
    sourceCommit: requiredString(
      options.sourceCommit,
      "sourceCommit",
      COMMIT_PATTERN,
    ),
    ownerPrincipal: requiredString(
      options.ownerPrincipal,
      "ownerPrincipal",
      SAFE_ID_PATTERN,
    ),
    shellPid: requiredInteger(options.shellPid, "shellPid"),
    ttlMs:
      options.ttlMs === undefined
        ? 90 * 60_000
        : requiredInteger(options.ttlMs, "ttlMs"),
    now: options.now === undefined ? new Date() : new Date(options.now),
    quarantineOlderCandidates: options.quarantineOlderCandidates !== false,
  };
}

export async function acquireRendererReleaseLease(options) {
  const normalized = normalizeLeaseOptions(options);
  if (Number.isNaN(normalized.now.valueOf()))
    throw new Error("now is invalid.");
  if (normalized.ttlMs < 60_000 || normalized.ttlMs > 24 * 60 * 60_000) {
    throw new Error("ttlMs must be between one minute and 24 hours.");
  }

  const coordinationRoot = path.join(normalized.stateRoot, "coordination");
  const leasePath = path.join(coordinationRoot, "activation-lease.json");
  if (await pathExists(leasePath)) {
    const existing = await readJson(leasePath);
    const expiresAt = Date.parse(existing.expiresAt ?? "");
    if (
      existing.status === "held" &&
      Number.isFinite(expiresAt) &&
      expiresAt > normalized.now.valueOf()
    ) {
      throw new Error(
        `Renderer release lease is already held by ${existing.ownerPrincipal ?? "unknown"} for ${existing.targetReleaseId ?? "unknown"}.`,
      );
    }
  }

  const latest = await readLatestRendererState(normalized.stateRoot);
  const activeRelease = latest.state.activeRelease;
  const activeReleaseId = activeRelease?.releaseId ?? null;
  const activeSequence = activeRelease?.releaseSequence ?? null;
  const sequenceFloor = requiredInteger(
    latest.state.highestReleaseSequence,
    "highestReleaseSequence",
  );
  const target = await readCandidate(normalized.candidateDirectory);
  if (target.releaseSequence <= sequenceFloor) {
    throw new Error(
      `Candidate sequence ${target.releaseSequence} must be newer than highest accepted sequence ${sequenceFloor}.`,
    );
  }

  const candidates = await listCandidates(normalized.stateRoot);
  const newer = candidates.filter(
    (candidate) => candidate.releaseSequence > target.releaseSequence,
  );
  if (newer.length > 0) {
    throw new Error(
      `A newer Renderer candidate exists: ${newer.map((candidate) => candidate.releaseId).join(", ")}.`,
    );
  }

  const leaseId = `renderer-${randomUUID()}`;
  const acquiredAt = normalized.now.toISOString();
  const lease = {
    schemaVersion: LEASE_SCHEMA,
    leaseId,
    status: "held",
    ownerPrincipal: normalized.ownerPrincipal,
    originTaskId: normalized.originTaskId,
    targetReleaseId: target.releaseId,
    targetReleaseSequence: target.releaseSequence,
    sourceCommit: normalized.sourceCommit,
    manifestSha256: target.manifestSha256,
    previousActiveReleaseId: activeReleaseId,
    previousActiveSequence: activeSequence,
    shellPid: normalized.shellPid,
    acquiredAt,
    expiresAt: new Date(
      normalized.now.valueOf() + normalized.ttlMs,
    ).toISOString(),
    policy: {
      allowShellRestart: false,
      requireCommittedSnapshot: true,
      requireMonotonicSequence: true,
      requireOriginTask: true,
      quarantineOlderCandidates: normalized.quarantineOlderCandidates,
    },
  };
  await writeJsonAtomic(leasePath, lease);

  const provenancePath = path.join(
    coordinationRoot,
    "releases",
    `${target.releaseId}.json`,
  );
  await writeJsonAtomic(provenancePath, {
    schemaVersion: PROVENANCE_SCHEMA,
    releaseId: target.releaseId,
    releaseSequence: target.releaseSequence,
    version: target.version,
    channel: target.channel,
    sourceCommit: normalized.sourceCommit,
    originTaskId: normalized.originTaskId,
    ownerPrincipal: normalized.ownerPrincipal,
    manifestSha256: target.manifestSha256,
    candidateDirectory: normalized.candidateDirectory,
    stagedAt: acquiredAt,
    leaseId,
  });

  const quarantined = [];
  let quarantineRoot = null;
  if (normalized.quarantineOlderCandidates) {
    quarantineRoot = path.join(
      normalized.stateRoot,
      "quarantine",
      `${acquiredAt.replaceAll(/[:.]/gu, "-")}-${leaseId.slice(-8)}`,
    );
    await mkdir(quarantineRoot, { recursive: true });
    for (const candidate of candidates) {
      if (
        candidate.releaseId === target.releaseId ||
        candidate.releaseId === activeReleaseId ||
        candidate.releaseSequence >= target.releaseSequence
      ) {
        continue;
      }
      const destination = path.join(
        quarantineRoot,
        path.basename(candidate.directory),
      );
      await rename(candidate.directory, destination);
      quarantined.push({
        releaseId: candidate.releaseId,
        releaseSequence: candidate.releaseSequence,
        from: candidate.directory,
        to: destination,
      });
    }
    await writeJsonAtomic(
      path.join(quarantineRoot, "quarantine-receipt.json"),
      {
        schemaVersion: QUARANTINE_SCHEMA,
        leaseId,
        targetReleaseId: target.releaseId,
        activeReleaseId,
        createdAt: acquiredAt,
        entries: quarantined,
      },
    );
  }

  return {
    lease,
    leasePath,
    provenancePath,
    quarantineRoot,
    quarantined,
    stateRevision: latest.revision,
  };
}

export async function verifyRendererRelease(options) {
  const stateRoot = path.resolve(
    requiredString(options.stateRoot, "stateRoot"),
  );
  const expectedReleaseId = requiredString(
    options.releaseId,
    "releaseId",
    SAFE_ID_PATTERN,
  );
  const expectedSequence = requiredInteger(
    options.releaseSequence,
    "releaseSequence",
  );
  const latest = await readLatestRendererState(stateRoot);
  const activeRelease = latest.state?.activeRelease;
  if (activeRelease?.releaseId !== expectedReleaseId) {
    throw new Error(
      `Active Renderer is ${activeRelease?.releaseId ?? "missing"}, not ${expectedReleaseId}.`,
    );
  }
  if (Number(activeRelease.releaseSequence) !== expectedSequence) {
    throw new Error(
      "Active Renderer releaseSequence does not match the lease target.",
    );
  }
  if (
    latest.state?.lastFailure !== null &&
    latest.state?.lastFailure !== undefined
  ) {
    throw new Error("Renderer state reports a lastFailure after activation.");
  }
  if (!(await pathExists(path.join(stateRoot, "slots", expectedReleaseId)))) {
    throw new Error("Active Renderer slot is missing.");
  }
  return { latest, activeRelease };
}

export async function completeRendererReleaseLease(options) {
  const stateRoot = path.resolve(
    requiredString(options.stateRoot, "stateRoot"),
  );
  const leasePath = path.join(
    stateRoot,
    "coordination",
    "activation-lease.json",
  );
  const lease = await readJson(leasePath);
  if (lease.schemaVersion !== LEASE_SCHEMA || lease.status !== "held") {
    throw new Error("No held Renderer activation lease exists.");
  }
  if (options.leaseId !== undefined && lease.leaseId !== options.leaseId) {
    throw new Error("Renderer activation lease ID does not match.");
  }
  const status = options.status === "failed" ? "failed" : "completed";
  if (status === "completed") {
    await verifyRendererRelease({
      stateRoot,
      releaseId: lease.targetReleaseId,
      releaseSequence: lease.targetReleaseSequence,
    });
    if (lease.shellPid !== null) {
      const observedShellPid = requiredInteger(options.shellPid, "shellPid");
      if (observedShellPid !== lease.shellPid) {
        throw new Error(
          "Sovereign Shell PID changed while the Renderer lease was held.",
        );
      }
    }
  }
  const completedAt = new Date(options.now ?? Date.now());
  if (Number.isNaN(completedAt.valueOf())) {
    throw new Error("now is invalid.");
  }
  const completed = {
    ...lease,
    status,
    completedAt: completedAt.toISOString(),
    result: options.result ?? null,
  };
  await writeJsonAtomic(leasePath, completed);
  return completed;
}

function parseArguments(argv) {
  const [command = "status", ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--"))
      throw new Error(`Unexpected argument: ${token}`);
    const key = token
      .slice(2)
      .replaceAll(/-([a-z])/gu, (_all, letter) => letter.toUpperCase());
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`Missing value for ${token}`);
    values[key] = value;
    index += 1;
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "acquire") {
    const result = await acquireRendererReleaseLease({
      stateRoot: values.stateRoot,
      releaseId: values.releaseId,
      candidateDirectory: values.candidateDirectory,
      originTaskId: values.originTaskId,
      sourceCommit: values.sourceCommit,
      ownerPrincipal: values.ownerPrincipal,
      shellPid: values.shellPid,
      ttlMs: values.ttlMs,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const result = await verifyRendererRelease({
      stateRoot: values.stateRoot,
      releaseId: values.releaseId,
      releaseSequence: values.releaseSequence,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "complete" || command === "fail") {
    const result = await completeRendererReleaseLease({
      stateRoot: values.stateRoot,
      leaseId: values.leaseId,
      status: command === "fail" ? "failed" : "completed",
      shellPid: values.shellPid,
      result: values.result ?? null,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "status") {
    const stateRoot = path.resolve(
      requiredString(values.stateRoot, "stateRoot"),
    );
    const leasePath = path.join(
      stateRoot,
      "coordination",
      "activation-lease.json",
    );
    const lease = (await pathExists(leasePath))
      ? await readJson(leasePath)
      : null;
    const latest = await readLatestRendererState(stateRoot);
    process.stdout.write(`${JSON.stringify({ lease, latest }, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

const invokedPath =
  process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (
  invokedPath ===
  path.resolve(
    new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) =>
      value.slice(1),
    ),
  )
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
