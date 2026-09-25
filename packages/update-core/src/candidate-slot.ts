import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
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
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  canonicalReleaseJson,
  releaseSha256,
  validateReleaseComponentPath,
  verifySignedReleaseEnvelope,
  type ReleaseCompatibility,
  type ReleaseComponent,
  type ReleaseManifest,
  type TrustedReleasePublicKey,
  type VerifiedReleaseEnvelope,
} from "./manifest.js";

export const CANDIDATE_SLOT_READY_SCHEMA_VERSION =
  "scr.candidate-slot-ready/v1" as const;

const SLOT_METADATA_DIRECTORY = ".scr-update";
const SLOT_ENVELOPE_FILE = `${SLOT_METADATA_DIRECTORY}/envelope.json`;
const SLOT_READY_FILE = `${SLOT_METADATA_DIRECTORY}/ready.json`;
const READY_TEMPORARY_PATTERN = /^\.slot-ready-\d+-[a-f0-9-]{36}\.tmp$/u;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const READY_MARKER_KEYS = [
  "schemaVersion",
  "releaseId",
  "releaseSequence",
  "manifestSha256",
  "envelopeSha256",
  "signingKeyId",
  "componentCount",
  "totalBytes",
] as const;

export type CandidateSlotErrorCode =
  | "INVALID_SLOT_PATH"
  | "UNSAFE_SLOT_PATH"
  | "RELEASE_VERIFICATION_FAILED"
  | "PAYLOAD_INVENTORY_MISMATCH"
  | "PAYLOAD_COMPONENT_INVALID"
  | "SLOT_ALREADY_EXISTS"
  | "SLOT_NOT_READY"
  | "SLOT_PUBLICATION_CONFLICT"
  | "SLOT_CORRUPT"
  | "SLOT_IO_FAILED";

export class CandidateSlotError extends Error {
  readonly code: CandidateSlotErrorCode;

  constructor(
    code: CandidateSlotErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "CandidateSlotError";
    this.code = code;
  }
}

/**
 * The stable bootstrap supplies logical component streams only. A filesystem-
 * backed implementation of this interface must open source files without
 * following symbolic links, junctions, or other reparse points. Archive-backed
 * implementations must reject duplicate, absolute, and traversal entry names
 * before exposing them here.
 */
export interface CandidatePayloadSource {
  readonly listComponents: () => Promise<readonly string[]>;
  readonly openComponent: (
    componentPath: string,
  ) => Promise<AsyncIterable<Uint8Array>>;
}

export interface CandidateSlotReadyMarker {
  readonly schemaVersion: typeof CANDIDATE_SLOT_READY_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly manifestSha256: string;
  readonly envelopeSha256: string;
  readonly signingKeyId: string;
  readonly componentCount: number;
  readonly totalBytes: number;
}

export interface CandidateSlotInspection {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly channel: ReleaseManifest["channel"];
  readonly createdAt: string;
  readonly slotPath: string;
  readonly entrypoint: string;
  readonly compatibility: ReleaseCompatibility;
  readonly manifestSha256: string;
  readonly envelopeSha256: string;
  readonly signingKeyId: string;
  readonly componentCount: number;
  readonly totalBytes: number;
  readonly directorySyncCompleted: boolean;
}

export type CandidateSlotMaterializationResult = CandidateSlotInspection;

export interface MaterializeCandidateSlotInput {
  readonly slotsDirectory: string;
  readonly signedEnvelope: unknown;
  readonly trustedKeys: readonly TrustedReleasePublicKey[];
  readonly source: CandidatePayloadSource;
  readonly maximumChunkBytes?: number;
  readonly maximumChunksPerComponent?: number;
  readonly signal?: AbortSignal;
}

export interface InspectCandidateSlotInput {
  readonly slotsDirectory: string;
  readonly releaseId: string;
  readonly trustedKeys: readonly TrustedReleasePublicKey[];
}

interface WrittenFile {
  readonly bytes: number;
  readonly sha256: string;
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
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `${label} contains an unknown field: ${key}`,
      );
    }
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `${label} is missing the required field: ${key}`,
      );
    }
  }
}

function equalSha256(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
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

function assertAbsoluteLocalPath(value: string, label: string): string {
  const localWindowsPath = process.platform !== "win32" ||
    (
      /^[A-Za-z]:[\\/]/u.test(value) &&
      !value.startsWith("\\\\") &&
      !value.startsWith("\\?\\") &&
      !value.startsWith("\\.\\")
    );
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    !localWindowsPath
  ) {
    throw new CandidateSlotError(
      "INVALID_SLOT_PATH",
      `${label} must be an absolute local path.`,
    );
  }
  return resolve(value);
}

function validateReleaseId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    !RELEASE_ID_PATTERN.test(value)
  ) {
    throw new CandidateSlotError(
      "INVALID_SLOT_PATH",
      "Candidate release ID has an invalid shape.",
    );
  }
  return value;
}

function assertContained(rootPath: string, candidatePath: string): void {
  const contained = relative(rootPath, candidatePath);
  if (
    contained === "" ||
    contained === ".." ||
    contained.startsWith(`..${sep}`) ||
    isAbsolute(contained)
  ) {
    throw new CandidateSlotError(
      "UNSAFE_SLOT_PATH",
      "Candidate slot path escapes its trusted root.",
    );
  }
}

function containedPath(rootPath: string, relativePath: string): string {
  const candidate = resolve(rootPath, ...relativePath.split("/"));
  assertContained(rootPath, candidate);
  return candidate;
}

async function ensureRealDirectory(
  directoryPath: string,
  label: string,
): Promise<string> {
  let info;
  try {
    info = await lstat(directoryPath);
  } catch (error) {
    throw new CandidateSlotError(
      "UNSAFE_SLOT_PATH",
      `${label} is unavailable.`,
      { cause: error },
    );
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new CandidateSlotError(
      "UNSAFE_SLOT_PATH",
      `${label} must be a real directory.`,
    );
  }
  const resolvedPath = await realpath(directoryPath);
  if (!samePath(directoryPath, resolvedPath)) {
    throw new CandidateSlotError(
      "UNSAFE_SLOT_PATH",
      `${label} may not traverse a symbolic link or junction.`,
    );
  }
  return resolvedPath;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev === 0 || left.ino === 0 || right.dev === 0 || right.ino === 0) {
    return true;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSingleLink(info: Stats, label: string): void {
  if (info.nlink > 1) {
    throw new CandidateSlotError(
      "UNSAFE_SLOT_PATH",
      `${label} may not be shared through a hard link.`,
    );
  }
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

async function writeFully(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (result.bytesWritten < 1) {
      throw new CandidateSlotError(
        "SLOT_IO_FAILED",
        "Candidate slot write made no forward progress.",
      );
    }
    offset += result.bytesWritten;
  }
}

async function writeBufferExclusive(
  absolutePath: string,
  bytes: Uint8Array,
): Promise<WrittenFile> {
  let handle;
  let createdFile = false;
  let succeeded = false;
  try {
    handle = await open(absolutePath, "wx", 0o600);
    createdFile = true;
    await writeFully(handle, bytes);
    await handle.sync();
    if (process.platform !== "win32") {
      await handle.chmod(0o400).catch(() => undefined);
    }
    succeeded = true;
    return {
      bytes: bytes.byteLength,
      sha256: releaseSha256(bytes),
    };
  } catch (error) {
    if (error instanceof CandidateSlotError) throw error;
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new CandidateSlotError(
        "SLOT_PUBLICATION_CONFLICT",
        "Candidate slot metadata already exists.",
        { cause: error },
      );
    }
    throw new CandidateSlotError(
      "SLOT_IO_FAILED",
      "Candidate slot metadata could not be written.",
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
    if (createdFile && !succeeded) {
      await unlink(absolutePath).catch(() => undefined);
    }
  }
}

function assertMaterializationNotAborted(
  signal: AbortSignal | undefined,
  componentPath: string,
  phase: "before" | "while",
): void {
  if (signal?.aborted) {
    throw new CandidateSlotError(
      "PAYLOAD_COMPONENT_INVALID",
      `Candidate materialization was cancelled ${phase} writing: ${componentPath}`,
    );
  }
}

async function writeComponentExclusive(
  absolutePath: string,
  component: ReleaseComponent,
  source: CandidatePayloadSource,
  maximumChunkBytes: number,
  maximumChunks: number,
  signal: AbortSignal | undefined,
): Promise<WrittenFile> {
  let stream: AsyncIterable<Uint8Array>;
  try {
    stream = await source.openComponent(component.path);
  } catch (error) {
    throw new CandidateSlotError(
      "PAYLOAD_COMPONENT_INVALID",
      `Candidate component could not be opened: ${component.path}`,
      { cause: error },
    );
  }
  if (
    stream === null ||
    typeof stream !== "object" ||
    typeof stream[Symbol.asyncIterator] !== "function"
  ) {
    throw new CandidateSlotError(
      "PAYLOAD_COMPONENT_INVALID",
      `Candidate component source is not an async byte stream: ${component.path}`,
    );
  }

  let handle;
  let createdFile = false;
  let succeeded = false;
  let totalBytes = 0;
  let chunkCount = 0;
  const digest = createHash("sha256");
  try {
    assertMaterializationNotAborted(signal, component.path, "before");
    handle = await open(absolutePath, "wx", 0o600);
    createdFile = true;
    for await (const chunk of stream) {
      assertMaterializationNotAborted(signal, component.path, "while");
      chunkCount += 1;
      if (chunkCount > maximumChunks) {
        throw new CandidateSlotError(
          "PAYLOAD_COMPONENT_INVALID",
          `Candidate component yielded too many chunks: ${component.path}`,
        );
      }
      if (!(chunk instanceof Uint8Array)) {
        throw new CandidateSlotError(
          "PAYLOAD_COMPONENT_INVALID",
          `Candidate component yielded a non-byte chunk: ${component.path}`,
        );
      }
      if (chunk.byteLength < 1) {
        throw new CandidateSlotError(
          "PAYLOAD_COMPONENT_INVALID",
          `Candidate component yielded an empty chunk: ${component.path}`,
        );
      }
      if (chunk.byteLength > maximumChunkBytes) {
        throw new CandidateSlotError(
          "PAYLOAD_COMPONENT_INVALID",
          `Candidate component chunk exceeds its limit: ${component.path}`,
        );
      }
      totalBytes += chunk.byteLength;
      if (
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > component.bytes
      ) {
        throw new CandidateSlotError(
          "PAYLOAD_COMPONENT_INVALID",
          `Candidate component exceeds its signed byte length: ${component.path}`,
        );
      }
      if (chunk.byteLength > 0) {
        digest.update(chunk);
        await writeFully(handle, chunk);
      }
    }
    if (totalBytes !== component.bytes) {
      throw new CandidateSlotError(
        "PAYLOAD_COMPONENT_INVALID",
        `Candidate component byte length does not match the signed manifest: ${component.path}`,
      );
    }
    const sha256 = digest.digest("hex");
    if (!equalSha256(sha256, component.sha256)) {
      throw new CandidateSlotError(
        "PAYLOAD_COMPONENT_INVALID",
        `Candidate component SHA-256 does not match the signed manifest: ${component.path}`,
      );
    }
    await handle.sync();
    if (process.platform !== "win32") {
      await handle.chmod(0o400).catch(() => undefined);
    }
    succeeded = true;
    return { bytes: totalBytes, sha256 };
  } catch (error) {
    if (error instanceof CandidateSlotError) throw error;
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new CandidateSlotError(
        "SLOT_PUBLICATION_CONFLICT",
        `Candidate component path already exists: ${component.path}`,
        { cause: error },
      );
    }
    throw new CandidateSlotError(
      isNodeError(error) ? "SLOT_IO_FAILED" : "PAYLOAD_COMPONENT_INVALID",
      isNodeError(error)
        ? `Candidate component could not be materialized: ${component.path}`
        : `Candidate component stream failed: ${component.path}`,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
    if (createdFile && !succeeded) {
      await unlink(absolutePath).catch(() => undefined);
    }
  }
}

function validateSourceInventory(
  sourcePaths: readonly string[],
  manifest: ReleaseManifest,
): void {
  if (!Array.isArray(sourcePaths) || sourcePaths.length !== manifest.components.length) {
    throw new CandidateSlotError(
      "PAYLOAD_INVENTORY_MISMATCH",
      "Candidate source has missing or extra component entries.",
    );
  }
  const sourceByLowerPath = new Map<string, string>();
  for (const rawPath of sourcePaths) {
    let componentPath: string;
    try {
      componentPath = validateReleaseComponentPath(rawPath);
    } catch (error) {
      throw new CandidateSlotError(
        "PAYLOAD_INVENTORY_MISMATCH",
        "Candidate source contains an invalid component path.",
        { cause: error },
      );
    }
    const key = componentPath.toLowerCase();
    if (sourceByLowerPath.has(key)) {
      throw new CandidateSlotError(
        "PAYLOAD_INVENTORY_MISMATCH",
        `Candidate source contains a duplicate component path: ${componentPath}`,
      );
    }
    sourceByLowerPath.set(key, componentPath);
  }
  for (const component of manifest.components) {
    const actual = sourceByLowerPath.get(component.path.toLowerCase());
    if (actual !== component.path) {
      throw new CandidateSlotError(
        "PAYLOAD_INVENTORY_MISMATCH",
        `Candidate source inventory does not exactly match the signed path: ${component.path}`,
      );
    }
  }
}

async function createComponentParentDirectories(
  slotPath: string,
  componentPath: string,
  createdDirectories: Set<string>,
): Promise<void> {
  const segments = componentPath.split("/");
  let relativeDirectory = "";
  for (const segment of segments.slice(0, -1)) {
    relativeDirectory = relativeDirectory.length === 0
      ? segment
      : `${relativeDirectory}/${segment}`;
    if (createdDirectories.has(relativeDirectory)) continue;
    const absoluteDirectory = containedPath(slotPath, relativeDirectory);
    try {
      await mkdir(absoluteDirectory, { mode: 0o700 });
    } catch (error) {
      throw new CandidateSlotError(
        isNodeError(error) && error.code === "EEXIST"
          ? "SLOT_PUBLICATION_CONFLICT"
          : "SLOT_IO_FAILED",
        `Candidate component directory could not be created: ${relativeDirectory}`,
        { cause: error },
      );
    }
    const realDirectory = await ensureRealDirectory(
      absoluteDirectory,
      "Candidate component directory",
    );
    assertContained(slotPath, realDirectory);
    createdDirectories.add(relativeDirectory);
  }
}

function parseReadyMarker(value: unknown): CandidateSlotReadyMarker {
  if (!isRecord(value)) {
    throw new CandidateSlotError(
      "SLOT_CORRUPT",
      "Candidate slot ready marker must be a JSON object.",
    );
  }
  assertExactKeys(value, READY_MARKER_KEYS, "Candidate slot ready marker");
  if (value.schemaVersion !== CANDIDATE_SLOT_READY_SCHEMA_VERSION) {
    throw new CandidateSlotError(
      "SLOT_CORRUPT",
      "Unsupported candidate slot ready-marker schema.",
    );
  }
  if (typeof value.releaseId !== "string") {
    throw new CandidateSlotError("SLOT_CORRUPT", "Candidate slot release ID is invalid.");
  }
  const releaseId = validateReleaseId(value.releaseId);
  if (
    typeof value.releaseSequence !== "number" ||
    !Number.isSafeInteger(value.releaseSequence) ||
    value.releaseSequence < 1 ||
    typeof value.componentCount !== "number" ||
    !Number.isSafeInteger(value.componentCount) ||
    value.componentCount < 1 ||
    typeof value.totalBytes !== "number" ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 1 ||
    typeof value.signingKeyId !== "string" ||
    !RELEASE_ID_PATTERN.test(value.signingKeyId) ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.manifestSha256) ||
    typeof value.envelopeSha256 !== "string" ||
    !SHA256_PATTERN.test(value.envelopeSha256)
  ) {
    throw new CandidateSlotError(
      "SLOT_CORRUPT",
      "Candidate slot ready marker contains invalid values.",
    );
  }
  return {
    schemaVersion: CANDIDATE_SLOT_READY_SCHEMA_VERSION,
    releaseId,
    releaseSequence: value.releaseSequence,
    manifestSha256: value.manifestSha256,
    envelopeSha256: value.envelopeSha256,
    signingKeyId: value.signingKeyId,
    componentCount: value.componentCount,
    totalBytes: value.totalBytes,
  };
}

async function readBoundedRegularFile(
  slotRoot: string,
  relativePath: string,
  maximumBytes: number,
  missingCode: "SLOT_NOT_READY" | "SLOT_CORRUPT",
): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
  const absolutePath = containedPath(slotRoot, relativePath);
  let pathInfo;
  try {
    pathInfo = await lstat(absolutePath);
  } catch (error) {
    throw new CandidateSlotError(
      isNodeError(error) && error.code === "ENOENT"
        ? missingCode
        : "SLOT_IO_FAILED",
      `Candidate slot file is unavailable: ${relativePath}`,
      { cause: error },
    );
  }
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new CandidateSlotError(
      "UNSAFE_SLOT_PATH",
      `Candidate slot file is not a real regular file: ${relativePath}`,
    );
  }
  assertSingleLink(pathInfo, `Candidate slot file ${relativePath}`);
  const resolvedPath = await realpath(absolutePath);
  if (!samePath(absolutePath, resolvedPath)) {
    throw new CandidateSlotError(
      "UNSAFE_SLOT_PATH",
      `Candidate slot file traverses a symbolic link or junction: ${relativePath}`,
    );
  }
  assertContained(slotRoot, resolvedPath);
  let handle;
  try {
    handle = await open(absolutePath, "r");
    const handleInfo = await handle.stat();
    assertSingleLink(handleInfo, `Candidate slot file ${relativePath}`);
    if (!handleInfo.isFile() || !sameFileIdentity(pathInfo, handleInfo)) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `Candidate slot file changed while it was being opened: ${relativePath}`,
      );
    }
    if (handleInfo.size < 1 || handleInfo.size > maximumBytes) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `Candidate slot file has an invalid byte length: ${relativePath}`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== handleInfo.size) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `Candidate slot file changed while it was being read: ${relativePath}`,
      );
    }
    const finalInfo = await handle.stat();
    if (
      finalInfo.size !== handleInfo.size ||
      finalInfo.mtimeMs !== handleInfo.mtimeMs ||
      finalInfo.ctimeMs !== handleInfo.ctimeMs
    ) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `Candidate slot file changed while it was being verified: ${relativePath}`,
      );
    }
    return { bytes, sha256: releaseSha256(bytes) };
  } catch (error) {
    if (error instanceof CandidateSlotError) throw error;
    throw new CandidateSlotError(
      "SLOT_IO_FAILED",
      `Candidate slot file could not be read: ${relativePath}`,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyComponentFile(
  slotRoot: string,
  component: ReleaseComponent,
): Promise<void> {
  const absolutePath = containedPath(slotRoot, component.path);
  const pathInfo = await lstat(absolutePath).catch((error: unknown) => {
    throw new CandidateSlotError(
      "SLOT_CORRUPT",
      `Candidate slot component is missing: ${component.path}`,
      { cause: error },
    );
  });
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new CandidateSlotError(
      "UNSAFE_SLOT_PATH",
      `Candidate slot component is not a real regular file: ${component.path}`,
    );
  }
  assertSingleLink(pathInfo, `Candidate slot component ${component.path}`);
  const resolvedPath = await realpath(absolutePath);
  if (!samePath(absolutePath, resolvedPath)) {
    throw new CandidateSlotError(
      "UNSAFE_SLOT_PATH",
      `Candidate slot component traverses a symbolic link or junction: ${component.path}`,
    );
  }
  assertContained(slotRoot, resolvedPath);
  let handle;
  try {
    handle = await open(absolutePath, "r");
    const handleInfo = await handle.stat();
    assertSingleLink(handleInfo, `Candidate slot component ${component.path}`);
    if (
      !handleInfo.isFile() ||
      !sameFileIdentity(pathInfo, handleInfo) ||
      handleInfo.size !== component.bytes
    ) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `Candidate slot component size or identity changed: ${component.path}`,
      );
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < component.bytes) {
      const requested = Math.min(buffer.byteLength, component.bytes - offset);
      const result = await handle.read(buffer, 0, requested, offset);
      if (result.bytesRead < 1) {
        throw new CandidateSlotError(
          "SLOT_CORRUPT",
          `Candidate slot component ended unexpectedly: ${component.path}`,
        );
      }
      digest.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    if (!equalSha256(digest.digest("hex"), component.sha256)) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `Candidate slot component hash does not match the signed manifest: ${component.path}`,
      );
    }
    const finalInfo = await handle.stat();
    if (
      finalInfo.size !== handleInfo.size ||
      finalInfo.mtimeMs !== handleInfo.mtimeMs ||
      finalInfo.ctimeMs !== handleInfo.ctimeMs
    ) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `Candidate slot component changed while it was being verified: ${component.path}`,
      );
    }
  } catch (error) {
    if (error instanceof CandidateSlotError) throw error;
    throw new CandidateSlotError(
      "SLOT_IO_FAILED",
      `Candidate slot component could not be verified: ${component.path}`,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function expectedSlotDirectories(manifest: ReleaseManifest): Set<string> {
  const directories = new Set<string>([SLOT_METADATA_DIRECTORY]);
  for (const component of manifest.components) {
    const segments = component.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

async function assertExactSlotInventory(
  slotRoot: string,
  manifest: ReleaseManifest,
): Promise<void> {
  const expectedFiles = new Set<string>([
    SLOT_ENVELOPE_FILE,
    SLOT_READY_FILE,
    ...manifest.components.map((component) => component.path),
  ]);
  const expectedDirectories = expectedSlotDirectories(manifest);
  const observedFiles = new Set<string>();
  const observedDirectories = new Set<string>();
  const queue: string[] = [""];
  let observedEntries = 0;

  while (queue.length > 0) {
    const relativeDirectory = queue.shift()!;
    const absoluteDirectory = relativeDirectory.length === 0
      ? slotRoot
      : containedPath(slotRoot, relativeDirectory);
    const resolvedDirectory = await ensureRealDirectory(
      absoluteDirectory,
      "Candidate slot directory",
    );
    if (relativeDirectory.length > 0) {
      assertContained(slotRoot, resolvedDirectory);
    }
    let entries: Dirent[];
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      throw new CandidateSlotError(
        "SLOT_IO_FAILED",
        "Candidate slot directory could not be enumerated.",
        { cause: error },
      );
    }
    for (const entry of entries) {
      observedEntries += 1;
      if (observedEntries > 4_096) {
        throw new CandidateSlotError(
          "SLOT_CORRUPT",
          "Candidate slot entry count exceeds its limit.",
        );
      }
      if (entry.isSymbolicLink()) {
        throw new CandidateSlotError(
          "UNSAFE_SLOT_PATH",
          "Candidate slot contains a symbolic link or junction.",
        );
      }
      const child = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(child)) {
          throw new CandidateSlotError(
            "SLOT_CORRUPT",
            `Candidate slot contains an unexpected directory: ${child}`,
          );
        }
        observedDirectories.add(child);
        queue.push(child);
        continue;
      }
      if (!entry.isFile()) {
        throw new CandidateSlotError(
          "SLOT_CORRUPT",
          `Candidate slot contains a non-regular entry: ${child}`,
        );
      }
      if (
        relativeDirectory === SLOT_METADATA_DIRECTORY &&
        READY_TEMPORARY_PATTERN.test(entry.name)
      ) {
        continue;
      }
      if (!expectedFiles.has(child)) {
        throw new CandidateSlotError(
          "SLOT_CORRUPT",
          `Candidate slot contains an unexpected file: ${child}`,
        );
      }
      observedFiles.add(child);
    }
  }

  for (const expected of expectedFiles) {
    if (!observedFiles.has(expected)) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `Candidate slot is missing an expected file: ${expected}`,
      );
    }
  }
  for (const expected of expectedDirectories) {
    if (!observedDirectories.has(expected)) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `Candidate slot is missing an expected directory: ${expected}`,
      );
    }
  }
}

function verifyEnvelope(
  signedEnvelope: unknown,
  trustedKeys: readonly TrustedReleasePublicKey[],
): VerifiedReleaseEnvelope {
  try {
    return verifySignedReleaseEnvelope(signedEnvelope, trustedKeys);
  } catch (error) {
    throw new CandidateSlotError(
      "RELEASE_VERIFICATION_FAILED",
      "Candidate release signature envelope could not be verified.",
      { cause: error },
    );
  }
}

export async function inspectCandidateSlot(
  input: InspectCandidateSlotInput,
): Promise<CandidateSlotInspection> {
  const slotsDirectory = assertAbsoluteLocalPath(
    input.slotsDirectory,
    "Candidate slots directory",
  );
  const slotsRoot = await ensureRealDirectory(
    slotsDirectory,
    "Candidate slots directory",
  );
  const releaseId = validateReleaseId(input.releaseId);
  const slotPath = containedPath(slotsRoot, releaseId);
  try {
    await lstat(slotPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new CandidateSlotError(
        "SLOT_NOT_READY",
        "Candidate release slot does not exist.",
        { cause: error },
      );
    }
    throw new CandidateSlotError(
      "SLOT_IO_FAILED",
      "Candidate release slot could not be inspected.",
      { cause: error },
    );
  }
  const slotRoot = await ensureRealDirectory(slotPath, "Candidate release slot");
  assertContained(slotsRoot, slotRoot);
  const metadataPath = containedPath(slotRoot, SLOT_METADATA_DIRECTORY);
  try {
    await lstat(metadataPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new CandidateSlotError(
        "SLOT_NOT_READY",
        "Candidate slot metadata has not been created yet.",
        { cause: error },
      );
    }
    throw error;
  }
  const metadataRoot = await ensureRealDirectory(
    metadataPath,
    "Candidate slot metadata directory",
  );
  assertContained(slotRoot, metadataRoot);

  const readyFile = await readBoundedRegularFile(
    slotRoot,
    SLOT_READY_FILE,
    64 * 1024,
    "SLOT_NOT_READY",
  );
  let markerValue: unknown;
  try {
    markerValue = JSON.parse(readyFile.bytes.toString("utf8"));
  } catch (error) {
    throw new CandidateSlotError(
      "SLOT_CORRUPT",
      "Candidate slot ready marker is not valid JSON.",
      { cause: error },
    );
  }
  const marker = parseReadyMarker(markerValue);
  if (marker.releaseId !== releaseId) {
    throw new CandidateSlotError(
      "SLOT_CORRUPT",
      "Candidate slot ready marker does not match its directory identity.",
    );
  }

  const envelopeFile = await readBoundedRegularFile(
    slotRoot,
    SLOT_ENVELOPE_FILE,
    512 * 1024,
    "SLOT_CORRUPT",
  );
  if (!equalSha256(envelopeFile.sha256, marker.envelopeSha256)) {
    throw new CandidateSlotError(
      "SLOT_CORRUPT",
      "Candidate slot envelope bytes do not match the ready marker.",
    );
  }
  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(envelopeFile.bytes.toString("utf8"));
  } catch (error) {
    throw new CandidateSlotError(
      "SLOT_CORRUPT",
      "Candidate slot envelope is not valid JSON.",
      { cause: error },
    );
  }
  const verified = verifyEnvelope(envelopeValue, input.trustedKeys);
  const manifest = verified.envelope.manifest;
  if (
    manifest.releaseId !== releaseId ||
    manifest.releaseSequence !== marker.releaseSequence ||
    verified.envelope.manifestSha256 !== marker.manifestSha256 ||
    verified.signingKeyId !== marker.signingKeyId ||
    manifest.components.length !== marker.componentCount ||
    manifest.totalBytes !== marker.totalBytes
  ) {
    throw new CandidateSlotError(
      "SLOT_CORRUPT",
      "Candidate slot ready marker does not match its signed release envelope.",
    );
  }

  await assertExactSlotInventory(slotRoot, manifest);
  for (const component of manifest.components) {
    await verifyComponentFile(slotRoot, component);
  }
  const inspectionDirectories = [
    ...[...expectedSlotDirectories(manifest)].map((relativeDirectory) =>
      containedPath(slotRoot, relativeDirectory)
    ),
    slotRoot,
    slotsRoot,
  ];
  const directorySyncResults = await Promise.all(
    [...new Set(inspectionDirectories)].map((directoryPath) =>
      syncDirectoryBestEffort(directoryPath)
    ),
  );
  return {
    releaseId,
    releaseSequence: manifest.releaseSequence,
    version: manifest.version,
    channel: manifest.channel,
    createdAt: manifest.createdAt,
    slotPath: slotRoot,
    entrypoint: manifest.entrypoint,
    compatibility: manifest.compatibility,
    manifestSha256: verified.envelope.manifestSha256,
    envelopeSha256: envelopeFile.sha256,
    signingKeyId: verified.signingKeyId,
    componentCount: manifest.components.length,
    totalBytes: manifest.totalBytes,
    directorySyncCompleted: directorySyncResults.every(Boolean),
  };
}

export async function materializeCandidateSlot(
  input: MaterializeCandidateSlotInput,
): Promise<CandidateSlotMaterializationResult> {
  const slotsDirectory = assertAbsoluteLocalPath(
    input.slotsDirectory,
    "Candidate slots directory",
  );
  const slotsRoot = await ensureRealDirectory(
    slotsDirectory,
    "Candidate slots directory",
  );
  const maximumChunkBytes = input.maximumChunkBytes ?? 4 * 1024 * 1024;
  const maximumChunks = input.maximumChunksPerComponent ?? 131_072;
  if (
    !Number.isSafeInteger(maximumChunkBytes) ||
    maximumChunkBytes < 1 ||
    maximumChunkBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(maximumChunks) ||
    maximumChunks < 1 ||
    maximumChunks > 1_000_000
  ) {
    throw new CandidateSlotError(
      "PAYLOAD_COMPONENT_INVALID",
      "Candidate component chunk limits are invalid.",
    );
  }
  if (input.signal?.aborted === true) {
    throw new CandidateSlotError(
      "PAYLOAD_COMPONENT_INVALID",
      "Candidate materialization was cancelled before verification.",
    );
  }
  const verified = verifyEnvelope(input.signedEnvelope, input.trustedKeys);
  const manifest = verified.envelope.manifest;
  let sourcePaths: readonly string[];
  try {
    sourcePaths = await input.source.listComponents();
  } catch (error) {
    throw new CandidateSlotError(
      "PAYLOAD_INVENTORY_MISMATCH",
      "Candidate source inventory could not be listed.",
      { cause: error },
    );
  }
  validateSourceInventory(sourcePaths, manifest);

  const slotPath = containedPath(slotsRoot, manifest.releaseId);
  try {
    await mkdir(slotPath, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new CandidateSlotError(
        "SLOT_ALREADY_EXISTS",
        "Candidate release slot already exists and will not be overwritten.",
        { cause: error },
      );
    }
    throw new CandidateSlotError(
      "SLOT_IO_FAILED",
      "Candidate release slot could not be created.",
      { cause: error },
    );
  }
  const slotRoot = await ensureRealDirectory(slotPath, "Candidate release slot");
  assertContained(slotsRoot, slotRoot);
  const metadataPath = containedPath(slotRoot, SLOT_METADATA_DIRECTORY);
  try {
    await mkdir(metadataPath, { mode: 0o700 });
  } catch (error) {
    throw new CandidateSlotError(
      "SLOT_IO_FAILED",
      "Candidate slot metadata directory could not be created.",
      { cause: error },
    );
  }
  const metadataRoot = await ensureRealDirectory(
    metadataPath,
    "Candidate slot metadata directory",
  );
  assertContained(slotRoot, metadataRoot);

  const envelopeBytes = Buffer.from(
    `${canonicalReleaseJson(verified.envelope)}\n`,
    "utf8",
  );
  const envelopeFile = await writeBufferExclusive(
    containedPath(slotRoot, SLOT_ENVELOPE_FILE),
    envelopeBytes,
  );
  const createdDirectories = new Set<string>([SLOT_METADATA_DIRECTORY]);
  for (const component of [...manifest.components].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  )) {
    await createComponentParentDirectories(
      slotRoot,
      component.path,
      createdDirectories,
    );
    const written = await writeComponentExclusive(
      containedPath(slotRoot, component.path),
      component,
      input.source,
      maximumChunkBytes,
      maximumChunks,
      input.signal,
    );
    if (
      written.bytes !== component.bytes ||
      !equalSha256(written.sha256, component.sha256)
    ) {
      throw new CandidateSlotError(
        "SLOT_CORRUPT",
        `Candidate component verification changed after materialization: ${component.path}`,
      );
    }
  }

  const prePublicationDirectories = [
    ...[...createdDirectories].map((relativeDirectory) =>
      containedPath(slotRoot, relativeDirectory)
    ),
    slotRoot,
  ];
  const prePublicationSyncResults = await Promise.all(
    [...new Set(prePublicationDirectories)].map((directoryPath) =>
      syncDirectoryBestEffort(directoryPath)
    ),
  );

  const marker: CandidateSlotReadyMarker = {
    schemaVersion: CANDIDATE_SLOT_READY_SCHEMA_VERSION,
    releaseId: manifest.releaseId,
    releaseSequence: manifest.releaseSequence,
    manifestSha256: verified.envelope.manifestSha256,
    envelopeSha256: envelopeFile.sha256,
    signingKeyId: verified.signingKeyId,
    componentCount: manifest.components.length,
    totalBytes: manifest.totalBytes,
  };
  const markerBytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
  const temporaryReadyName =
    `.slot-ready-${process.pid}-${randomUUID()}.tmp`;
  const temporaryReadyPath = join(metadataRoot, temporaryReadyName);
  const readyPath = containedPath(slotRoot, SLOT_READY_FILE);
  await writeBufferExclusive(temporaryReadyPath, markerBytes);
  try {
    await link(temporaryReadyPath, readyPath);
  } catch (error) {
    throw new CandidateSlotError(
      isNodeError(error) && error.code === "EEXIST"
        ? "SLOT_PUBLICATION_CONFLICT"
        : "SLOT_IO_FAILED",
      "Candidate slot ready marker could not be published atomically.",
      { cause: error },
    );
  } finally {
    await unlink(temporaryReadyPath).catch(() => undefined);
  }

  const syncResults = await Promise.all([
    syncDirectoryBestEffort(metadataRoot),
    syncDirectoryBestEffort(slotRoot),
    syncDirectoryBestEffort(slotsRoot),
  ]);
  const inspection = await inspectCandidateSlot({
    slotsDirectory: slotsRoot,
    releaseId: manifest.releaseId,
    trustedKeys: input.trustedKeys,
  });
  return {
    ...inspection,
    directorySyncCompleted:
      prePublicationSyncResults.every(Boolean) &&
      syncResults.every(Boolean) &&
      inspection.directorySyncCompleted,
  };
}
