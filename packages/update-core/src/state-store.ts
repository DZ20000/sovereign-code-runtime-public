import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { releaseSha256 } from "./manifest.js";
import {
  parseUpdateState,
  type UpdateState,
} from "./state-machine.js";

export const BOOTSTRAP_UPDATE_STATE_SCHEMA_VERSION =
  "scr.bootstrap-update-state/v1" as const;

const REVISION_FILE_PATTERN = /^revision-(\d{16})\.json$/u;
const TEMPORARY_FILE_PATTERN = /^\.bootstrap-update-state-\d+-[a-f0-9-]{36}\.tmp$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ENVELOPE_KEYS = [
  "schemaVersion",
  "storageRevision",
  "previousStateSha256",
  "state",
] as const;

export type BootstrapUpdateStateStoreErrorCode =
  | "INVALID_STORE_PATH"
  | "INVALID_STORE_OPTIONS"
  | "UNSAFE_STORE_PATH"
  | "STATE_ALREADY_EXISTS"
  | "STATE_NOT_FOUND"
  | "STATE_CONFLICT"
  | "STATE_CORRUPT"
  | "STATE_TOO_LARGE"
  | "STATE_REVISION_LIMIT"
  | "STATE_IO_FAILED";

export class BootstrapUpdateStateStoreError extends Error {
  readonly code: BootstrapUpdateStateStoreErrorCode;

  constructor(
    code: BootstrapUpdateStateStoreErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "BootstrapUpdateStateStoreError";
    this.code = code;
  }
}

export interface BootstrapUpdateStateEnvelope {
  readonly schemaVersion: typeof BOOTSTRAP_UPDATE_STATE_SCHEMA_VERSION;
  readonly storageRevision: number;
  readonly previousStateSha256: string | null;
  readonly state: UpdateState;
}

export interface BootstrapUpdateStateSnapshot {
  readonly storageRevision: number;
  readonly previousStateSha256: string | null;
  readonly state: UpdateState;
  readonly sha256: string;
  readonly bytes: number;
  readonly fileName: string;
}

export interface BootstrapUpdateStateExpectation {
  readonly storageRevision: number;
  readonly sha256: string;
}

export interface BootstrapUpdateStateWriteResult
  extends BootstrapUpdateStateSnapshot {
  readonly directorySyncCompleted: boolean;
}

export interface BootstrapUpdateStateStoreOptions {
  readonly directoryPath: string;
  readonly maximumStateBytes?: number;
  readonly maximumChainBytes?: number;
  readonly maximumRevisions?: number;
  readonly maximumTemporaryFiles?: number;
}

interface RevisionEntry {
  readonly revision: number;
  readonly fileName: string;
}

interface DirectoryInventory {
  readonly revisions: readonly RevisionEntry[];
  readonly temporaryFiles: readonly string[];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_CORRUPT",
        `${label} contains an unknown field: ${key}`,
      );
    }
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_CORRUPT",
        `${label} is missing the required field: ${key}`,
      );
    }
  }
}

function assertPositiveBoundedInteger(
  value: number,
  label: string,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new BootstrapUpdateStateStoreError(
      "INVALID_STORE_OPTIONS",
      `${label} must be an integer from 1 through ${maximum}.`,
    );
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new BootstrapUpdateStateStoreError(
      "STATE_CORRUPT",
      `${label} must be a lowercase SHA-256 digest.`,
    );
  }
}

function equalSha256(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function comparablePath(value: string): string {
  const normalized = resolve(value)
    .replace(/^\\\\\?\\/u, "")
    .replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function formatRevisionFileName(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > Number.MAX_SAFE_INTEGER) {
    throw new BootstrapUpdateStateStoreError(
      "STATE_REVISION_LIMIT",
      "Bootstrap update-state revision exceeds the safe integer range.",
    );
  }
  const digits = String(revision);
  if (digits.length > 16) {
    throw new BootstrapUpdateStateStoreError(
      "STATE_REVISION_LIMIT",
      "Bootstrap update-state revision exceeds the filename range.",
    );
  }
  return `revision-${digits.padStart(16, "0")}.json`;
}

function parseRevisionFileName(fileName: string): number | null {
  const match = REVISION_FILE_PATTERN.exec(fileName);
  if (match === null) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

function serializeEnvelope(envelope: BootstrapUpdateStateEnvelope): Buffer {
  return Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

function parseEnvelope(
  value: unknown,
  expectedRevision: number,
  expectedPreviousSha256: string | null,
): BootstrapUpdateStateEnvelope {
  if (!isRecord(value)) {
    throw new BootstrapUpdateStateStoreError(
      "STATE_CORRUPT",
      "Bootstrap update-state revision must contain a JSON object.",
    );
  }
  assertExactKeys(value, ENVELOPE_KEYS, "Bootstrap update-state revision");
  if (value.schemaVersion !== BOOTSTRAP_UPDATE_STATE_SCHEMA_VERSION) {
    throw new BootstrapUpdateStateStoreError(
      "STATE_CORRUPT",
      "Unsupported bootstrap update-state schema version.",
    );
  }
  if (
    typeof value.storageRevision !== "number" ||
    !Number.isSafeInteger(value.storageRevision) ||
    value.storageRevision !== expectedRevision
  ) {
    throw new BootstrapUpdateStateStoreError(
      "STATE_CORRUPT",
      "Bootstrap update-state revision does not match its filename.",
    );
  }
  const previousStateSha256 = value.previousStateSha256;
  if (previousStateSha256 !== null) {
    assertSha256(previousStateSha256, "Previous bootstrap update-state SHA-256");
  }
  if (
    (expectedPreviousSha256 === null && previousStateSha256 !== null) ||
    (expectedPreviousSha256 !== null &&
      (previousStateSha256 === null ||
        !equalSha256(previousStateSha256, expectedPreviousSha256)))
  ) {
    throw new BootstrapUpdateStateStoreError(
      "STATE_CORRUPT",
      "Bootstrap update-state revision chain is broken.",
    );
  }
  let state: UpdateState;
  try {
    state = parseUpdateState(value.state);
  } catch (error) {
    throw new BootstrapUpdateStateStoreError(
      "STATE_CORRUPT",
      "Bootstrap update-state payload is invalid.",
      { cause: error },
    );
  }
  return {
    schemaVersion: BOOTSTRAP_UPDATE_STATE_SCHEMA_VERSION,
    storageRevision: expectedRevision,
    previousStateSha256,
    state,
  };
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev === 0 || left.ino === 0 || right.dev === 0 || right.ino === 0) {
    return true;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
    return true;
  } catch (error) {
    if (
      isNodeError(error) &&
      ["EACCES", "EBADF", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(
        error.code ?? "",
      )
    ) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class BootstrapUpdateStateStore {
  readonly #directoryPath: string;
  readonly #maximumStateBytes: number;
  readonly #maximumChainBytes: number;
  readonly #maximumRevisions: number;
  readonly #maximumTemporaryFiles: number;

  constructor(options: BootstrapUpdateStateStoreOptions) {
    const directoryPath = options.directoryPath;
    const windowsPathIsLocal = typeof directoryPath === "string" &&
      (
        process.platform !== "win32" ||
        (
          /^[A-Za-z]:[\\/]/u.test(directoryPath) &&
          !directoryPath.startsWith("\\\\") &&
          !directoryPath.startsWith("\\?\\") &&
          !directoryPath.startsWith("\\.\\")
        )
      );
    if (
      typeof directoryPath !== "string" ||
      options.directoryPath.length === 0 ||
      options.directoryPath.length > 4_096 ||
      options.directoryPath.includes("\0") ||
      !isAbsolute(options.directoryPath) ||
      !windowsPathIsLocal
    ) {
      throw new BootstrapUpdateStateStoreError(
        "INVALID_STORE_PATH",
        "Bootstrap update-state directory must be an absolute local path.",
      );
    }
    this.#directoryPath = resolve(directoryPath);
    this.#maximumStateBytes = options.maximumStateBytes ?? 262_144;
    this.#maximumChainBytes = options.maximumChainBytes ?? 16_777_216;
    this.#maximumRevisions = options.maximumRevisions ?? 4_096;
    this.#maximumTemporaryFiles = options.maximumTemporaryFiles ?? 64;
    assertPositiveBoundedInteger(
      this.#maximumStateBytes,
      "Maximum bootstrap state bytes",
      4_194_304,
    );
    assertPositiveBoundedInteger(
      this.#maximumChainBytes,
      "Maximum bootstrap state-chain bytes",
      268_435_456,
    );
    if (this.#maximumChainBytes < this.#maximumStateBytes) {
      throw new BootstrapUpdateStateStoreError(
        "INVALID_STORE_OPTIONS",
        "Maximum bootstrap state-chain bytes must cover at least one state revision.",
      );
    }
    assertPositiveBoundedInteger(
      this.#maximumRevisions,
      "Maximum bootstrap state revisions",
      100_000,
    );
    assertPositiveBoundedInteger(
      this.#maximumTemporaryFiles,
      "Maximum bootstrap temporary files",
      10_000,
    );
  }

  directoryPath(): string {
    return this.#directoryPath;
  }

  async #ensureSafeDirectory(): Promise<void> {
    const parentPath = dirname(this.#directoryPath);
    let parentInfo;
    try {
      parentInfo = await lstat(parentPath);
    } catch (error) {
      throw new BootstrapUpdateStateStoreError(
        "UNSAFE_STORE_PATH",
        "Bootstrap update-state parent directory is unavailable.",
        { cause: error },
      );
    }
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new BootstrapUpdateStateStoreError(
        "UNSAFE_STORE_PATH",
        "Bootstrap update-state parent must be a real directory.",
      );
    }
    const parentRealPath = await realpath(parentPath);
    if (!samePath(parentPath, parentRealPath)) {
      throw new BootstrapUpdateStateStoreError(
        "UNSAFE_STORE_PATH",
        "Bootstrap update-state parent may not traverse a symbolic link or junction.",
      );
    }

    try {
      await mkdir(this.#directoryPath, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw new BootstrapUpdateStateStoreError(
          "STATE_IO_FAILED",
          "Bootstrap update-state directory could not be created.",
          { cause: error },
        );
      }
    }

    const directoryInfo = await lstat(this.#directoryPath);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new BootstrapUpdateStateStoreError(
        "UNSAFE_STORE_PATH",
        "Bootstrap update-state path must be a real directory.",
      );
    }
    const directoryRealPath = await realpath(this.#directoryPath);
    if (!samePath(this.#directoryPath, directoryRealPath)) {
      throw new BootstrapUpdateStateStoreError(
        "UNSAFE_STORE_PATH",
        "Bootstrap update-state directory may not be a symbolic link or junction.",
      );
    }
    const contained = relative(parentRealPath, directoryRealPath);
    if (
      contained === "" ||
      contained === ".." ||
      contained.startsWith(`..${sep}`) ||
      isAbsolute(contained)
    ) {
      throw new BootstrapUpdateStateStoreError(
        "UNSAFE_STORE_PATH",
        "Bootstrap update-state directory escapes its trusted parent.",
      );
    }
  }

  async #inventory(): Promise<DirectoryInventory> {
    await this.#ensureSafeDirectory();
    let entries: Dirent[];
    try {
      entries = await readdir(this.#directoryPath, { withFileTypes: true });
    } catch (error) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_IO_FAILED",
        "Bootstrap update-state directory could not be enumerated.",
        { cause: error },
      );
    }
    const revisions: RevisionEntry[] = [];
    const temporaryFiles: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new BootstrapUpdateStateStoreError(
          "UNSAFE_STORE_PATH",
          "Bootstrap update-state directory contains a symbolic link or junction.",
        );
      }
      const revision = parseRevisionFileName(entry.name);
      if (revision !== null) {
        if (!entry.isFile()) {
          throw new BootstrapUpdateStateStoreError(
            "STATE_CORRUPT",
            "Bootstrap update-state revision is not a regular file.",
          );
        }
        revisions.push({ revision, fileName: entry.name });
        continue;
      }
      if (TEMPORARY_FILE_PATTERN.test(entry.name)) {
        if (!entry.isFile()) {
          throw new BootstrapUpdateStateStoreError(
            "STATE_CORRUPT",
            "Bootstrap update-state temporary entry is not a regular file.",
          );
        }
        temporaryFiles.push(entry.name);
        continue;
      }
      throw new BootstrapUpdateStateStoreError(
        "STATE_CORRUPT",
        `Bootstrap update-state directory contains an unexpected entry: ${entry.name}`,
      );
    }
    if (revisions.length > this.#maximumRevisions) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_REVISION_LIMIT",
        "Bootstrap update-state revision count exceeds its configured limit.",
      );
    }
    if (temporaryFiles.length > this.#maximumTemporaryFiles) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_REVISION_LIMIT",
        "Bootstrap update-state temporary-file count exceeds its configured limit.",
      );
    }
    revisions.sort((left, right) => left.revision - right.revision);
    for (let index = 0; index < revisions.length; index += 1) {
      if (revisions[index]!.revision !== index + 1) {
        throw new BootstrapUpdateStateStoreError(
          "STATE_CORRUPT",
          "Bootstrap update-state revisions are not contiguous from revision one.",
        );
      }
    }
    temporaryFiles.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return { revisions, temporaryFiles };
  }

  async #readRevision(
    entry: RevisionEntry,
    expectedPreviousSha256: string | null,
  ): Promise<BootstrapUpdateStateSnapshot> {
    const absolutePath = join(this.#directoryPath, entry.fileName);
    let pathInfo;
    try {
      pathInfo = await lstat(absolutePath);
    } catch (error) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_CORRUPT",
        "Bootstrap update-state revision disappeared while it was being read.",
        { cause: error },
      );
    }
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
      throw new BootstrapUpdateStateStoreError(
        "UNSAFE_STORE_PATH",
        "Bootstrap update-state revision must be a regular file, not a link.",
      );
    }
    let handle;
    try {
      handle = await open(absolutePath, "r");
      const handleInfo = await handle.stat();
      if (!handleInfo.isFile() || !sameFileIdentity(pathInfo, handleInfo)) {
        throw new BootstrapUpdateStateStoreError(
          "STATE_CORRUPT",
          "Bootstrap update-state revision changed while it was being opened.",
        );
      }
      if (handleInfo.size < 1 || handleInfo.size > this.#maximumStateBytes) {
        throw new BootstrapUpdateStateStoreError(
          handleInfo.size > this.#maximumStateBytes ? "STATE_TOO_LARGE" : "STATE_CORRUPT",
          "Bootstrap update-state revision has an invalid byte length.",
        );
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength !== handleInfo.size) {
        throw new BootstrapUpdateStateStoreError(
          "STATE_CORRUPT",
          "Bootstrap update-state revision changed while it was being read.",
        );
      }
      const sha256 = releaseSha256(bytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        throw new BootstrapUpdateStateStoreError(
          "STATE_CORRUPT",
          "Bootstrap update-state revision is not valid JSON.",
          { cause: error },
        );
      }
      const envelope = parseEnvelope(
        parsed,
        entry.revision,
        expectedPreviousSha256,
      );
      return {
        storageRevision: envelope.storageRevision,
        previousStateSha256: envelope.previousStateSha256,
        state: envelope.state,
        sha256,
        bytes: bytes.byteLength,
        fileName: entry.fileName,
      };
    } catch (error) {
      if (error instanceof BootstrapUpdateStateStoreError) throw error;
      throw new BootstrapUpdateStateStoreError(
        "STATE_IO_FAILED",
        "Bootstrap update-state revision could not be read.",
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #readChain(): Promise<readonly BootstrapUpdateStateSnapshot[]> {
    const inventory = await this.#inventory();
    const snapshots: BootstrapUpdateStateSnapshot[] = [];
    let previousSha256: string | null = null;
    let chainBytes = 0;
    for (const entry of inventory.revisions) {
      const snapshot = await this.#readRevision(entry, previousSha256);
      chainBytes += snapshot.bytes;
      if (!Number.isSafeInteger(chainBytes) || chainBytes > this.#maximumChainBytes) {
        throw new BootstrapUpdateStateStoreError(
          "STATE_TOO_LARGE",
          "Bootstrap update-state revision chain exceeds its configured byte limit.",
        );
      }
      snapshots.push(snapshot);
      previousSha256 = snapshot.sha256;
    }
    return snapshots;
  }

  async read(): Promise<BootstrapUpdateStateSnapshot | null> {
    const chain = await this.#readChain();
    return chain.at(-1) ?? null;
  }

  async temporaryFiles(): Promise<readonly string[]> {
    return (await this.#inventory()).temporaryFiles;
  }

  async create(state: UpdateState): Promise<BootstrapUpdateStateWriteResult> {
    let parsedState: UpdateState;
    try {
      parsedState = parseUpdateState(state);
    } catch (error) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_CORRUPT",
        "Initial bootstrap update state is invalid.",
        { cause: error },
      );
    }
    const existing = await this.#readChain();
    if (existing.length > 0) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_ALREADY_EXISTS",
        "Bootstrap update state already exists.",
      );
    }
    return await this.#publish(1, null, parsedState);
  }

  async replace(
    state: UpdateState,
    expected: BootstrapUpdateStateExpectation,
  ): Promise<BootstrapUpdateStateWriteResult> {
    if (
      !Number.isSafeInteger(expected.storageRevision) ||
      expected.storageRevision < 1 ||
      !SHA256_PATTERN.test(expected.sha256)
    ) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_CONFLICT",
        "Bootstrap update-state expectation is invalid.",
      );
    }
    let parsedState: UpdateState;
    try {
      parsedState = parseUpdateState(state);
    } catch (error) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_CORRUPT",
        "Replacement bootstrap update state is invalid.",
        { cause: error },
      );
    }
    const chain = await this.#readChain();
    const current = chain.at(-1);
    if (current === undefined) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_NOT_FOUND",
        "Bootstrap update state has not been created.",
      );
    }
    if (
      current.storageRevision !== expected.storageRevision ||
      !equalSha256(current.sha256, expected.sha256)
    ) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_CONFLICT",
        "Bootstrap update state changed after it was read.",
      );
    }
    return await this.#publish(
      current.storageRevision + 1,
      current.sha256,
      parsedState,
    );
  }

  async #publish(
    storageRevision: number,
    previousStateSha256: string | null,
    state: UpdateState,
  ): Promise<BootstrapUpdateStateWriteResult> {
    if (storageRevision > this.#maximumRevisions) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_REVISION_LIMIT",
        "Bootstrap update-state revision exceeds its configured limit.",
      );
    }
    await this.#ensureSafeDirectory();
    const envelope: BootstrapUpdateStateEnvelope = {
      schemaVersion: BOOTSTRAP_UPDATE_STATE_SCHEMA_VERSION,
      storageRevision,
      previousStateSha256,
      state,
    };
    const bytes = serializeEnvelope(envelope);
    if (bytes.byteLength > this.#maximumStateBytes) {
      throw new BootstrapUpdateStateStoreError(
        "STATE_TOO_LARGE",
        "Bootstrap update state exceeds its configured byte limit.",
      );
    }
    const fileName = formatRevisionFileName(storageRevision);
    const destinationPath = join(this.#directoryPath, fileName);
    const temporaryFileName =
      `.bootstrap-update-state-${process.pid}-${randomUUID()}.tmp`;
    const temporaryPath = join(this.#directoryPath, temporaryFileName);
    let handle;
    let published = false;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      if (process.platform !== "win32") {
        await handle.chmod(0o400).catch(() => undefined);
      }
      await handle.close();
      handle = undefined;
      try {
        await link(temporaryPath, destinationPath);
        published = true;
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new BootstrapUpdateStateStoreError(
            "STATE_CONFLICT",
            "Another bootstrap update-state writer published the next revision first.",
            { cause: error },
          );
        }
        throw error;
      }
      const directorySyncCompleted = await syncDirectoryBestEffort(
        this.#directoryPath,
      );
      const snapshot = await this.#readRevision(
        { revision: storageRevision, fileName },
        previousStateSha256,
      );
      const expectedSha256 = releaseSha256(bytes);
      if (!equalSha256(snapshot.sha256, expectedSha256)) {
        throw new BootstrapUpdateStateStoreError(
          "STATE_CORRUPT",
          "Published bootstrap update-state bytes do not match the prepared revision.",
        );
      }
      return { ...snapshot, directorySyncCompleted };
    } catch (error) {
      if (error instanceof BootstrapUpdateStateStoreError) throw error;
      throw new BootstrapUpdateStateStoreError(
        published ? "STATE_CORRUPT" : "STATE_IO_FAILED",
        published
          ? "Bootstrap update state was published but could not be verified."
          : "Bootstrap update state could not be published atomically.",
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          // A leftover temporary file is safe and will be reported by temporaryFiles().
        }
      });
    }
  }
}
