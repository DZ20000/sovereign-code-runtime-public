import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream, type Dirent } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
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
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const RENDERER_SLOT_MANIFEST_SCHEMA_VERSION =
  "scr.renderer-slot-manifest/v1" as const;
export const RENDERER_SLOT_METADATA_SCHEMA_VERSION =
  "scr.renderer-slot-metadata/v1" as const;
export const RENDERER_SLOT_POINTER_SCHEMA_VERSION =
  "scr.renderer-slot-pointer/v1" as const;

const SLOT_METADATA_FILE = "slot-metadata.json";
const ACTIVE_POINTER_FILE = "active-renderer.json";
const RELEASE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_MANIFEST_FILES = 20_000;
const MAX_ASSET_BYTES = 512 * 1_024 * 1_024;

export interface RendererAssetDescriptor {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface RendererSlotManifest {
  readonly schemaVersion: typeof RENDERER_SLOT_MANIFEST_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly entrypoint: string;
  readonly files: readonly RendererAssetDescriptor[];
}

export interface RendererSlotMetadata {
  readonly schemaVersion: typeof RENDERER_SLOT_METADATA_SCHEMA_VERSION;
  readonly manifestSha256: string;
  readonly installedAt: number;
  readonly manifest: RendererSlotManifest;
}

export interface RendererSlotPointer {
  readonly schemaVersion: typeof RENDERER_SLOT_POINTER_SCHEMA_VERSION;
  readonly generation: number;
  readonly activeReleaseId: string;
  readonly previousReleaseId: string | null;
  readonly manifestSha256: string;
  readonly activatedAt: number;
}

export interface RendererSlotStatus {
  readonly releaseId: string;
  readonly directory: string;
  readonly entrypoint: string;
  readonly manifestSha256: string;
  readonly installedAt: number;
  readonly totalBytes: number;
  readonly fileCount: number;
}

export interface RendererSlotStoreOptions {
  readonly rootDirectory: string;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly now?: () => number;
}

export interface RendererSlotActivationOptions {
  readonly expectedGeneration?: number | null;
}

export interface RendererSlotPruneOptions {
  readonly keepReleaseIds?: readonly string[];
  readonly maxRetained?: number;
}

interface ScannedAsset {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly bytes: number;
}

interface ScannedTree {
  readonly files: ReadonlyMap<string, ScannedAsset>;
  readonly totalBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function assertReleaseId(value: unknown, label = "Renderer release ID"): asserts value is string {
  if (typeof value !== "string" || !RELEASE_ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function normalizeAssetPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value)
  ) {
    throw new Error(`${label} must be a bounded portable relative path.`);
  }
const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._@()+,~%-]+$/u.test(segment),
    )
  ) {
    throw new Error(`${label} contains an unsafe or non-portable path segment.`);
  }
  if (value.toLowerCase() === SLOT_METADATA_FILE.toLowerCase()) {
    throw new Error(`${label} collides with reserved slot metadata.`);
  }
  return segments.join("/");
}

function parseAssetDescriptor(value: unknown, index: number): RendererAssetDescriptor {
  if (!isRecord(value)) {
    throw new Error(`Renderer asset ${index} must be an object.`);
  }
  assertExactKeys(value, ["path", "sha256", "bytes"], `Renderer asset ${index}`);
  const path = normalizeAssetPath(value.path, `Renderer asset ${index} path`);
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(`Renderer asset ${path} has an invalid SHA-256 digest.`);
  }
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0 || (value.bytes as number) > MAX_ASSET_BYTES) {
    throw new Error(`Renderer asset ${path} has an invalid byte length.`);
  }
  return { path, sha256: value.sha256, bytes: value.bytes as number };
}

export function parseRendererSlotManifest(value: unknown): RendererSlotManifest {
  if (!isRecord(value)) {
    throw new Error("Renderer slot manifest must be an object.");
  }
  assertExactKeys(
    value,
    ["schemaVersion", "releaseId", "entrypoint", "files"],
    "Renderer slot manifest",
  );
  if (value.schemaVersion !== RENDERER_SLOT_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Unsupported renderer slot manifest schema version.");
  }
  assertReleaseId(value.releaseId);
  const entrypoint = normalizeAssetPath(value.entrypoint, "Renderer entrypoint");
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_MANIFEST_FILES) {
    throw new Error("Renderer slot manifest has an invalid file inventory.");
  }
  const files = value.files.map(parseAssetDescriptor).sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const portableNames = new Set<string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (portableNames.has(key)) {
      throw new Error(`Renderer slot manifest contains a duplicate portable path: ${file.path}.`);
    }
    portableNames.add(key);
  }
  if (!portableNames.has(entrypoint.toLowerCase())) {
    throw new Error("Renderer entrypoint is not present in the file inventory.");
  }
  return {
    schemaVersion: RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
    releaseId: value.releaseId,
    entrypoint,
    files,
  };
}

function rendererManifestPayload(manifest: RendererSlotManifest): string {
  const parsed = parseRendererSlotManifest(manifest);
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    releaseId: parsed.releaseId,
    entrypoint: parsed.entrypoint,
    files: parsed.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
    })),
  });
}

export function rendererManifestSha256(manifest: RendererSlotManifest): string {
  return createHash("sha256").update(rendererManifestPayload(manifest), "utf8").digest("hex");
}

function parseRendererSlotMetadata(value: unknown): RendererSlotMetadata {
  if (!isRecord(value)) {
    throw new Error("Renderer slot metadata must be an object.");
  }
  assertExactKeys(
    value,
    ["schemaVersion", "manifestSha256", "installedAt", "manifest"],
    "Renderer slot metadata",
  );
  if (value.schemaVersion !== RENDERER_SLOT_METADATA_SCHEMA_VERSION) {
    throw new Error("Unsupported renderer slot metadata schema version.");
  }
  if (typeof value.manifestSha256 !== "string" || !SHA256_PATTERN.test(value.manifestSha256)) {
    throw new Error("Renderer slot metadata has an invalid manifest digest.");
  }
  if (!Number.isSafeInteger(value.installedAt) || (value.installedAt as number) < 0) {
    throw new Error("Renderer slot metadata has an invalid installation timestamp.");
  }
  const manifest = parseRendererSlotManifest(value.manifest);
  if (rendererManifestSha256(manifest) !== value.manifestSha256) {
    throw new Error("Renderer slot metadata manifest digest does not match.");
  }
  return {
    schemaVersion: RENDERER_SLOT_METADATA_SCHEMA_VERSION,
    manifestSha256: value.manifestSha256,
    installedAt: value.installedAt as number,
    manifest,
  };
}

function parseRendererSlotPointer(value: unknown): RendererSlotPointer {
  if (!isRecord(value)) {
    throw new Error("Renderer slot pointer must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "generation",
      "activeReleaseId",
      "previousReleaseId",
      "manifestSha256",
      "activatedAt",
    ],
    "Renderer slot pointer",
  );
  if (value.schemaVersion !== RENDERER_SLOT_POINTER_SCHEMA_VERSION) {
    throw new Error("Unsupported renderer slot pointer schema version.");
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
    throw new Error("Renderer slot pointer generation is invalid.");
  }
  assertReleaseId(value.activeReleaseId, "Active renderer release ID");
  if (value.previousReleaseId !== null) {
    assertReleaseId(value.previousReleaseId, "Previous renderer release ID");
  }
  if (typeof value.manifestSha256 !== "string" || !SHA256_PATTERN.test(value.manifestSha256)) {
    throw new Error("Renderer slot pointer has an invalid manifest digest.");
  }
  if (!Number.isSafeInteger(value.activatedAt) || (value.activatedAt as number) < 0) {
    throw new Error("Renderer slot pointer has an invalid activation timestamp.");
  }
  return {
    schemaVersion: RENDERER_SLOT_POINTER_SCHEMA_VERSION,
    generation: value.generation as number,
    activeReleaseId: value.activeReleaseId,
    previousReleaseId: value.previousReleaseId,
    manifestSha256: value.manifestSha256,
    activatedAt: value.activatedAt as number,
  };
}

function containedPath(root: string, portablePath: string): string {
  const candidate = resolve(root, ...portablePath.split("/"));
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return candidate;
  }
  throw new Error(`Renderer asset escaped its slot root: ${portablePath}.`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function fileSha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

async function scanTree(
  root: string,
  maxFiles: number,
  maxTotalBytes: number,
  ignored = new Set<string>(),
): Promise<ScannedTree> {
  const files = new Map<string, ScannedAsset>();
  let totalBytes = 0;

  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })) as Dirent[];
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const portable = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Renderer source contains a symbolic link: ${portable}.`);
      }
      if (entry.isDirectory()) {
        await visit(absolute, portable);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Renderer source contains an unsupported filesystem entry: ${portable}.`);
      }
      if (ignored.has(portable.toLowerCase())) continue;
      const normalized = normalizeAssetPath(portable.replaceAll(sep, "/"), "Renderer source path");
      const key = normalized.toLowerCase();
      if (files.has(key)) {
        throw new Error(`Renderer source contains a duplicate portable path: ${normalized}.`);
      }
      const info = await stat(absolute);
      totalBytes += info.size;
      if (files.size + 1 > maxFiles || totalBytes > maxTotalBytes) {
        throw new Error("Renderer source exceeds the configured slot limits.");
      }
      files.set(key, { absolutePath: absolute, relativePath: normalized, bytes: info.size });
    }
  }

  await visit(root, "");
  return { files, totalBytes };
}

function totalManifestBytes(manifest: RendererSlotManifest): number {
  return manifest.files.reduce((total, file) => total + file.bytes, 0);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const temporary = join(dirname(path), `.${basename(path)}.${suffix}.tmp`);
  const backup = join(dirname(path), `.${basename(path)}.${suffix}.bak`);
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, path);
    return;
  } catch (error) {
    if (!["EEXIST", "EPERM", "EACCES"].includes(nodeErrorCode(error) ?? "")) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  let movedCurrent = false;
  try {
    if (await exists(path)) {
      await rename(path, backup);
      movedCurrent = true;
    }
    await rename(temporary, path);
    if (movedCurrent) await rm(backup, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (movedCurrent && !(await exists(path)) && (await exists(backup))) {
      await rename(backup, path).catch(() => undefined);
    }
    throw error;
  }
}

export class RendererSlotStore {
  readonly #rootDirectory: string;
  readonly #slotsDirectory: string;
  readonly #pointerPath: string;
  readonly #lockPath: string;
  readonly #maxFiles: number;
  readonly #maxTotalBytes: number;
  readonly #now: () => number;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: RendererSlotStoreOptions) {
    if (typeof options.rootDirectory !== "string" || options.rootDirectory.trim().length === 0) {
      throw new Error("Renderer slot root directory is required.");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#slotsDirectory = join(this.#rootDirectory, "slots");
    this.#pointerPath = join(this.#rootDirectory, ACTIVE_POINTER_FILE);
    this.#lockPath = join(this.#rootDirectory, "renderer-slots.lock");
    this.#maxFiles = options.maxFiles ?? 10_000;
    this.#maxTotalBytes = options.maxTotalBytes ?? 256 * 1_024 * 1_024;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#maxFiles) || this.#maxFiles < 1 || this.#maxFiles > MAX_MANIFEST_FILES) {
      throw new Error("Renderer slot file limit is invalid.");
    }
    if (
      !Number.isSafeInteger(this.#maxTotalBytes) ||
      this.#maxTotalBytes < 1 ||
      this.#maxTotalBytes > MAX_ASSET_BYTES
    ) {
      throw new Error("Renderer slot byte limit is invalid.");
    }
  }

  get rootDirectory(): string {
    return this.#rootDirectory;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#slotsDirectory, { recursive: true });
  }

  async readPointer(): Promise<RendererSlotPointer | null> {
    return await this.#readPointer(false);
  }

  async #readPointer(
    skipLockWait: boolean,
  ): Promise<RendererSlotPointer | null> {
    await this.#recoverPointerIfNeeded(skipLockWait);
    try {
      const pointer = parseRendererSlotPointer(
        JSON.parse(await readFile(this.#pointerPath, "utf8")) as unknown,
      );
      const active = await this.verifySlot(pointer.activeReleaseId);
      if (active.manifestSha256 !== pointer.manifestSha256) {
        throw new Error("Active renderer pointer does not match the installed slot manifest.");
      }
      return pointer;
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async stage(
    manifestValue: RendererSlotManifest,
    sourceDirectory: string,
  ): Promise<RendererSlotStatus> {
    return this.#serialize(async () => {
      await this.initialize();
      const manifest = parseRendererSlotManifest(manifestValue);
      if (manifest.files.length > this.#maxFiles || totalManifestBytes(manifest) > this.#maxTotalBytes) {
        throw new Error("Renderer manifest exceeds the configured slot limits.");
      }
      const sourceRoot = resolve(sourceDirectory);
      const sourceInfo = await lstat(sourceRoot);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
        throw new Error("Renderer source root must be a real directory.");
      }
      const sourceRealRoot = await realpath(sourceRoot);
      const sourceTree = await scanTree(sourceRealRoot, this.#maxFiles, this.#maxTotalBytes);
      this.#assertInventory(manifest, sourceTree);

      const destination = this.#slotDirectory(manifest.releaseId);
      if (await exists(destination)) {
        const current = await this.verifySlot(manifest.releaseId);
        if (current.manifestSha256 !== rendererManifestSha256(manifest)) {
          throw new Error(`Renderer release ${manifest.releaseId} already exists with different content.`);
        }
        return current;
      }

      const staging = join(
        this.#slotsDirectory,
        `.staging-${manifest.releaseId}-${randomBytes(8).toString("hex")}`,
      );
      await mkdir(staging, { recursive: false });
      try {
        for (const descriptor of manifest.files) {
          const source = sourceTree.files.get(descriptor.path.toLowerCase())!;
          const target = containedPath(staging, descriptor.path);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(source.absolutePath, target, fsConstants.COPYFILE_EXCL);
          await this.#verifyAsset(target, descriptor);
        }
        const metadata: RendererSlotMetadata = {
          schemaVersion: RENDERER_SLOT_METADATA_SCHEMA_VERSION,
          manifestSha256: rendererManifestSha256(manifest),
          installedAt: this.#now(),
          manifest,
        };
        await writeJsonAtomic(join(staging, SLOT_METADATA_FILE), metadata);
        try {
          await rename(staging, destination);
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(nodeErrorCode(error) ?? "")) {
            throw error;
          }
          const raced = await this.verifySlot(manifest.releaseId);
          if (raced.manifestSha256 !== metadata.manifestSha256) {
            throw new Error(`Renderer release ${manifest.releaseId} raced with different content.`);
          }
        }
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
      return await this.verifySlot(manifest.releaseId);
    });
  }

  async verifySlot(releaseId: string): Promise<RendererSlotStatus> {
    assertReleaseId(releaseId);
    const directory = this.#slotDirectory(releaseId);
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error(`Renderer slot ${releaseId} is not a real directory.`);
    }
    const metadataPath = join(directory, SLOT_METADATA_FILE);
    const metadataInfo = await lstat(metadataPath);
    if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) {
      throw new Error(`Renderer slot ${releaseId} metadata is not a regular file.`);
    }
    const metadata = parseRendererSlotMetadata(
      JSON.parse(await readFile(metadataPath, "utf8")) as unknown,
    );
    if (metadata.manifest.releaseId !== releaseId) {
      throw new Error(`Renderer slot ${releaseId} metadata names a different release.`);
    }
    if (
      metadata.manifest.files.length > this.#maxFiles ||
      totalManifestBytes(metadata.manifest) > this.#maxTotalBytes
    ) {
      throw new Error(`Renderer slot ${releaseId} exceeds the configured limits.`);
    }
    const tree = await scanTree(
      directory,
      this.#maxFiles,
      this.#maxTotalBytes,
      new Set([SLOT_METADATA_FILE.toLowerCase()]),
    );
    this.#assertInventory(metadata.manifest, tree);
    for (const descriptor of metadata.manifest.files) {
      const asset = tree.files.get(descriptor.path.toLowerCase())!;
      await this.#verifyAsset(asset.absolutePath, descriptor);
    }
    return {
      releaseId,
      directory,
      entrypoint: containedPath(directory, metadata.manifest.entrypoint),
      manifestSha256: metadata.manifestSha256,
      installedAt: metadata.installedAt,
      totalBytes: tree.totalBytes,
      fileCount: tree.files.size,
    };
  }

  async activate(
    releaseId: string,
    options: RendererSlotActivationOptions = {},
  ): Promise<RendererSlotPointer> {
    return this.#serialize(async () => {
      const slot = await this.verifySlot(releaseId);
      const current = await this.#readPointer(true);
      this.#assertExpectedGeneration(current, options.expectedGeneration);
      if (current?.activeReleaseId === releaseId) return current;
      const pointer: RendererSlotPointer = {
        schemaVersion: RENDERER_SLOT_POINTER_SCHEMA_VERSION,
        generation: (current?.generation ?? 0) + 1,
        activeReleaseId: releaseId,
        previousReleaseId: current?.activeReleaseId ?? null,
        manifestSha256: slot.manifestSha256,
        activatedAt: this.#now(),
      };
      await writeJsonAtomic(this.#pointerPath, pointer);
      return pointer;
    });
  }

  async rollback(options: RendererSlotActivationOptions = {}): Promise<RendererSlotPointer> {
    return this.#serialize(async () => {
      const current = await this.#readPointer(true);
      if (current === null || current.previousReleaseId === null) {
        throw new Error("No previous renderer slot is available for rollback.");
      }
      this.#assertExpectedGeneration(current, options.expectedGeneration);
      const previous = await this.verifySlot(current.previousReleaseId);
      const pointer: RendererSlotPointer = {
        schemaVersion: RENDERER_SLOT_POINTER_SCHEMA_VERSION,
        generation: current.generation + 1,
        activeReleaseId: current.previousReleaseId,
        previousReleaseId: current.activeReleaseId,
        manifestSha256: previous.manifestSha256,
        activatedAt: this.#now(),
      };
      await writeJsonAtomic(this.#pointerPath, pointer);
      return pointer;
    });
  }

  async resolveActiveEntrypoint(): Promise<string | null> {
    const pointer = await this.readPointer();
    if (pointer === null) return null;
    return (await this.verifySlot(pointer.activeReleaseId)).entrypoint;
  }

  async prune(options: RendererSlotPruneOptions = {}): Promise<readonly string[]> {
    return this.#serialize(async () => {
      await this.initialize();
      const pointer = await this.#readPointer(true);
      const keep = new Set((options.keepReleaseIds ?? []).map((value) => {
        assertReleaseId(value);
        return value;
      }));
      if (pointer !== null) {
        keep.add(pointer.activeReleaseId);
        if (pointer.previousReleaseId !== null) keep.add(pointer.previousReleaseId);
      }
      const maxRetained = options.maxRetained ?? 3;
      if (!Number.isSafeInteger(maxRetained) || maxRetained < 0 || maxRetained > 100) {
        throw new Error("Renderer retained-slot limit is invalid.");
      }
      const entries = await readdir(this.#slotsDirectory, { withFileTypes: true });
      const slots: RendererSlotStatus[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".staging-")) continue;
        assertReleaseId(entry.name);
        slots.push(await this.verifySlot(entry.name));
      }
      slots.sort((left, right) => right.installedAt - left.installedAt || left.releaseId < right.releaseId ? -1 : left.releaseId > right.releaseId ? 1 : 0);
      for (const slot of slots.slice(0, maxRetained)) keep.add(slot.releaseId);
      const removed: string[] = [];
      for (const slot of slots) {
        if (keep.has(slot.releaseId)) continue;
        await rm(slot.directory, { recursive: true, force: false });
        removed.push(slot.releaseId);
      }
      return removed.sort();
    });
  }

  #slotDirectory(releaseId: string): string {
    assertReleaseId(releaseId);
    return containedPath(this.#slotsDirectory, releaseId);
  }

  #assertInventory(manifest: RendererSlotManifest, tree: ScannedTree): void {
    if (tree.files.size !== manifest.files.length) {
      throw new Error(
        `Renderer inventory count mismatch: expected ${manifest.files.length}, observed ${tree.files.size}.`,
      );
    }
    if (tree.totalBytes !== totalManifestBytes(manifest)) {
      throw new Error("Renderer inventory byte total does not match the manifest.");
    }
    for (const descriptor of manifest.files) {
      const observed = tree.files.get(descriptor.path.toLowerCase());
      if (observed === undefined || observed.relativePath !== descriptor.path || observed.bytes !== descriptor.bytes) {
        throw new Error(`Renderer inventory does not match manifest entry ${descriptor.path}.`);
      }
    }
  }

  async #verifyAsset(path: string, descriptor: RendererAssetDescriptor): Promise<void> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== descriptor.bytes) {
      throw new Error(`Renderer asset ${descriptor.path} has unexpected filesystem metadata.`);
    }
    const digest = await fileSha256(path);
    if (digest !== descriptor.sha256) {
      throw new Error(`Renderer asset ${descriptor.path} failed SHA-256 verification.`);
    }
  }

  #assertExpectedGeneration(
    current: RendererSlotPointer | null,
    expected: number | null | undefined,
  ): void {
    if (expected === undefined) return;
    const observed = current?.generation ?? null;
    if (observed !== expected) {
      throw new Error(
        `Renderer pointer generation changed: expected ${String(expected)}, observed ${String(observed)}.`,
      );
    }
  }

  async #recoverPointerIfNeeded(skipLockWait: boolean): Promise<void> {
    await this.initialize();
    for (let attempt = 0; !skipLockWait && attempt < 40; attempt += 1) {
      if (await exists(this.#pointerPath)) return;
      if (!(await exists(this.#lockPath))) break;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    if (await exists(this.#pointerPath)) return;

    const prefix = `.${ACTIVE_POINTER_FILE}.`;
    const entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    const backups: { readonly path: string; readonly modifiedAt: number }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const path = join(this.#rootDirectory, entry.name);
      if (entry.name.endsWith(".bak")) {
        backups.push({ path, modifiedAt: (await stat(path)).mtimeMs });
      } else if (entry.name.endsWith(".tmp")) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
    backups.sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt ||
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    );
    const recover = backups.shift();
    if (recover !== undefined) {
      await rename(recover.path, this.#pointerPath);
    }
    await Promise.all(backups.map((backup) => rm(backup.path, { force: true })));
  }

  async #withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.#rootDirectory, { recursive: true });
    const deadlineAt = Date.now() + 10_000;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    while (handle === null) {
      try {
        handle = await open(this.#lockPath, "wx", 0o600);
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        try {
          const lock = await stat(this.#lockPath);
          if (Date.now() - lock.mtimeMs > 15 * 60_000) {
            await rm(this.#lockPath, { force: true });
            continue;
          }
        } catch (lockError) {
          if (nodeErrorCode(lockError) === "ENOENT") continue;
        }
        if (Date.now() >= deadlineAt) {
          throw new Error("Timed out waiting for the renderer slot mutation lock.");
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }

    try {
      await handle.writeFile(`${process.pid}\n`, { encoding: "utf8" });
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(this.#lockPath, { force: true }).catch(() => undefined);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const lockedOperation = () => this.#withFileLock(operation);
    const result = this.#mutationQueue.then(lockedOperation, lockedOperation);
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
