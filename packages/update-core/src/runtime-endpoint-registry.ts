import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const RUNTIME_ENDPOINT_SCHEMA_VERSION =
  "scr.runtime-endpoint/v1" as const;
export const RUNTIME_ENDPOINT_POINTER_SCHEMA_VERSION =
  "scr.runtime-endpoint-pointer/v1" as const;

const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ACTIVE_POINTER_FILE = "active-runtime.json";
const MAX_ENDPOINT_RECORDS = 256;
const MAX_RECORD_BYTES = 64 * 1_024;

export interface RuntimeEndpointRecord {
  readonly schemaVersion: typeof RUNTIME_ENDPOINT_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly releaseId: string;
  readonly endpointId: string;
  readonly processId: number;
  readonly protocolVersion: number;
  readonly manifestSha256: string;
  readonly startedAt: number;
}

export interface RuntimeEndpointReference {
  readonly instanceId: string;
  readonly recordSha256: string;
}

export interface RuntimeEndpointPointer {
  readonly schemaVersion: typeof RUNTIME_ENDPOINT_POINTER_SCHEMA_VERSION;
  readonly generation: number;
  readonly active: RuntimeEndpointReference;
  readonly previous: RuntimeEndpointReference | null;
  readonly checkpointId: string;
  readonly fencingToken: string;
  readonly switchedAt: number;
}

export interface RuntimeEndpointRegistryOptions {
  readonly rootDirectory: string;
  readonly now?: () => number;
}

export interface RuntimeEndpointActivation {
  readonly checkpointId: string;
  readonly fencingToken: string;
  readonly expectedGeneration?: number | null;
  readonly expectedActiveInstanceId?: string | null;
}

export interface RuntimeEndpointResolution {
  readonly pointer: RuntimeEndpointPointer;
  readonly endpoint: RuntimeEndpointRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (
    expected.length !== actual.length ||
    expected.some((key, index) => key !== actual[index])
  ) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !ENDPOINT_ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseEndpointRecord(value: unknown): RuntimeEndpointRecord {
  if (!isRecord(value)) {
    throw new Error("Runtime endpoint record must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "instanceId",
      "releaseId",
      "endpointId",
      "processId",
      "protocolVersion",
      "manifestSha256",
      "startedAt",
    ],
    "Runtime endpoint record",
  );
  if (value.schemaVersion !== RUNTIME_ENDPOINT_SCHEMA_VERSION) {
    throw new Error("Unsupported Runtime endpoint schema version.");
  }
  assertIdentifier(value.instanceId, "Runtime instance ID");
  assertIdentifier(value.releaseId, "Runtime release ID");
  assertIdentifier(value.endpointId, "Runtime endpoint ID");
  if (
    !Number.isSafeInteger(value.processId) ||
    (value.processId as number) < 1 ||
    (value.processId as number) > 0x7fff_ffff
  ) {
    throw new Error("Runtime endpoint process ID is invalid.");
  }
  if (
    !Number.isSafeInteger(value.protocolVersion) ||
    (value.protocolVersion as number) < 1 ||
    (value.protocolVersion as number) > 1_000_000
  ) {
    throw new Error("Runtime endpoint protocol version is invalid.");
  }
  assertSha256(value.manifestSha256, "Runtime endpoint manifest SHA-256");
  if (
    !Number.isSafeInteger(value.startedAt) ||
    (value.startedAt as number) < 0
  ) {
    throw new Error("Runtime endpoint start timestamp is invalid.");
  }
  return {
    schemaVersion: RUNTIME_ENDPOINT_SCHEMA_VERSION,
    instanceId: value.instanceId,
    releaseId: value.releaseId,
    endpointId: value.endpointId,
    processId: value.processId as number,
    protocolVersion: value.protocolVersion as number,
    manifestSha256: value.manifestSha256,
    startedAt: value.startedAt as number,
  };
}

function parseReference(
  value: unknown,
  label: string,
): RuntimeEndpointReference {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertExactKeys(value, ["instanceId", "recordSha256"], label);
  assertIdentifier(value.instanceId, `${label} instance ID`);
  assertSha256(value.recordSha256, `${label} record SHA-256`);
  return {
    instanceId: value.instanceId,
    recordSha256: value.recordSha256,
  };
}

function parsePointer(value: unknown): RuntimeEndpointPointer {
  if (!isRecord(value)) {
    throw new Error("Runtime endpoint pointer must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "generation",
      "active",
      "previous",
      "checkpointId",
      "fencingToken",
      "switchedAt",
    ],
    "Runtime endpoint pointer",
  );
  if (value.schemaVersion !== RUNTIME_ENDPOINT_POINTER_SCHEMA_VERSION) {
    throw new Error("Unsupported Runtime endpoint pointer schema version.");
  }
  if (
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1
  ) {
    throw new Error("Runtime endpoint pointer generation is invalid.");
  }
  const active = parseReference(
    value.active,
    "Active Runtime endpoint reference",
  );
  const previous =
    value.previous === null
      ? null
      : parseReference(value.previous, "Previous Runtime endpoint reference");
  assertIdentifier(value.checkpointId, "Runtime endpoint checkpoint ID");
  assertIdentifier(value.fencingToken, "Runtime endpoint fencing token");
  if (
    !Number.isSafeInteger(value.switchedAt) ||
    (value.switchedAt as number) < 0
  ) {
    throw new Error("Runtime endpoint switch timestamp is invalid.");
  }
  if (previous?.instanceId === active.instanceId) {
    throw new Error(
      "Runtime endpoint active and previous instances must differ.",
    );
  }
  return {
    schemaVersion: RUNTIME_ENDPOINT_POINTER_SCHEMA_VERSION,
    generation: value.generation as number,
    active,
    previous,
    checkpointId: value.checkpointId,
    fencingToken: value.fencingToken,
    switchedAt: value.switchedAt as number,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const temporary = join(dirname(path), `.${basename(path)}.${suffix}.tmp`);
  const backup = join(dirname(path), `.${basename(path)}.${suffix}.bak`);
  await writeFile(temporary, `${canonicalJson(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temporary, path);
    return;
  } catch (error) {
    if (!["EEXIST", "EPERM", "EACCES"].includes(nodeErrorCode(error) ?? "")) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  let moved = false;
  try {
    if (await exists(path)) {
      await rename(path, backup);
      moved = true;
    }
    await rename(temporary, path);
    if (moved) await rm(backup, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (moved && !(await exists(path)) && (await exists(backup))) {
      await rename(backup, path).catch(() => undefined);
    }
    throw error;
  }
}

export class RuntimeEndpointRegistry {
  readonly #rootDirectory: string;
  readonly #instancesDirectory: string;
  readonly #pointerPath: string;
  readonly #lockPath: string;
  readonly #now: () => number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RuntimeEndpointRegistryOptions) {
    if (
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.trim().length === 0
    ) {
      throw new Error("Runtime endpoint registry root directory is required.");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#instancesDirectory = join(this.#rootDirectory, "instances");
    this.#pointerPath = join(this.#rootDirectory, ACTIVE_POINTER_FILE);
    this.#lockPath = join(this.#rootDirectory, ".registry.lock");
    this.#now = options.now ?? Date.now;
  }

  get rootDirectory(): string {
    return this.#rootDirectory;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#instancesDirectory, { recursive: true });
  }

  async register(
    value: RuntimeEndpointRecord,
  ): Promise<RuntimeEndpointReference> {
    return await this.#serialize(async () => {
      await this.initialize();
      const record = parseEndpointRecord(value);
      const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
      if (bytes.length > MAX_RECORD_BYTES) {
        throw new Error("Runtime endpoint record exceeds its size limit.");
      }
      const digest = sha256(bytes);
      const path = this.#instancePath(record.instanceId);
      if (await exists(path)) {
        const existing = await this.readInstance(record.instanceId);
        const existingBytes = Buffer.from(
          `${canonicalJson(existing)}\n`,
          "utf8",
        );
        if (sha256(existingBytes) !== digest) {
          throw new Error(
            `Runtime instance ${record.instanceId} is already registered with different content.`,
          );
        }
        return { instanceId: record.instanceId, recordSha256: digest };
      }
      const entries = await readdir(this.#instancesDirectory);
      if (entries.length >= MAX_ENDPOINT_RECORDS) {
        throw new Error(
          "Runtime endpoint registry reached its instance limit.",
        );
      }
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      return { instanceId: record.instanceId, recordSha256: digest };
    });
  }

  async readInstance(instanceId: string): Promise<RuntimeEndpointRecord> {
    assertIdentifier(instanceId, "Runtime instance ID");
    const path = this.#instancePath(instanceId);
    const bytes = await readFile(path);
    if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) {
      throw new Error(
        `Runtime endpoint record ${instanceId} exceeds its size limit.`,
      );
    }
    const record = parseEndpointRecord(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
    if (record.instanceId !== instanceId) {
      throw new Error(
        `Runtime endpoint record ${instanceId} changes instance identity.`,
      );
    }
    return record;
  }

  async listInstances(): Promise<readonly RuntimeEndpointRecord[]> {
    await this.initialize();
    const entries = await readdir(this.#instancesDirectory, {
      withFileTypes: true,
    });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .sort();
    if (files.length > MAX_ENDPOINT_RECORDS) {
      throw new Error("Runtime endpoint registry exceeds its instance limit.");
    }
    const unsupported = entries.filter(
      (entry) => !(entry.isFile() && entry.name.endsWith(".json")),
    );
    if (unsupported.length > 0) {
      throw new Error(
        "Runtime endpoint registry contains unsupported entries.",
      );
    }
    return await Promise.all(
      files.map((instanceId) => this.readInstance(instanceId)),
    );
  }

  async readPointer(): Promise<RuntimeEndpointPointer | null> {
    await this.#recoverPointerIfNeeded(false);
    try {
      const bytes = await readFile(this.#pointerPath);
      if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) {
        throw new Error("Runtime endpoint pointer exceeds its size limit.");
      }
      return parsePointer(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async resolveActive(): Promise<RuntimeEndpointResolution | null> {
    const pointer = await this.readPointer();
    if (pointer === null) return null;
    return {
      pointer,
      endpoint: await this.#verifyReference(pointer.active),
    };
  }

  async activate(
    instanceId: string,
    input: RuntimeEndpointActivation,
  ): Promise<RuntimeEndpointPointer> {
    return await this.#serialize(async () => {
      assertIdentifier(instanceId, "Runtime instance ID");
      assertIdentifier(input.checkpointId, "Runtime checkpoint ID");
      assertIdentifier(input.fencingToken, "Runtime fencing token");
      const target = await this.#reference(instanceId);
      const current = await this.#readPointerInsideLock();
      this.#assertExpectations(current, input);
      if (current?.active.instanceId === instanceId) {
        if (current.active.recordSha256 !== target.recordSha256) {
          throw new Error(
            "Active Runtime endpoint record changed unexpectedly.",
          );
        }
        return current;
      }
      const pointer: RuntimeEndpointPointer = {
        schemaVersion: RUNTIME_ENDPOINT_POINTER_SCHEMA_VERSION,
        generation: (current?.generation ?? 0) + 1,
        active: target,
        previous: current?.active ?? null,
        checkpointId: input.checkpointId,
        fencingToken: input.fencingToken,
        switchedAt: this.#now(),
      };
      await writeJsonAtomic(this.#pointerPath, pointer);
      return pointer;
    });
  }

  async rollback(
    input: Omit<RuntimeEndpointActivation, "expectedActiveInstanceId">,
  ): Promise<RuntimeEndpointPointer> {
    return await this.#serialize(async () => {
      assertIdentifier(input.checkpointId, "Runtime checkpoint ID");
      assertIdentifier(input.fencingToken, "Runtime fencing token");
      const current = await this.#readPointerInsideLock();
      if (current === null || current.previous === null) {
        throw new Error(
          "No previous Runtime endpoint is available for rollback.",
        );
      }
      if (
        input.expectedGeneration !== undefined &&
        input.expectedGeneration !== current.generation
      ) {
        throw new Error(
          `Runtime endpoint generation changed: expected ${String(input.expectedGeneration)}, observed ${current.generation}.`,
        );
      }
      const previousRecord = await this.#verifyReference(current.previous);
      const previous = await this.#reference(previousRecord.instanceId);
      const pointer: RuntimeEndpointPointer = {
        schemaVersion: RUNTIME_ENDPOINT_POINTER_SCHEMA_VERSION,
        generation: current.generation + 1,
        active: previous,
        previous: current.active,
        checkpointId: input.checkpointId,
        fencingToken: input.fencingToken,
        switchedAt: this.#now(),
      };
      await writeJsonAtomic(this.#pointerPath, pointer);
      return pointer;
    });
  }

  async remove(instanceId: string): Promise<void> {
    await this.#serialize(async () => {
      assertIdentifier(instanceId, "Runtime instance ID");
      const pointer = await this.#readPointerInsideLock();
      if (
        pointer?.active.instanceId === instanceId ||
        pointer?.previous?.instanceId === instanceId
      ) {
        throw new Error(
          "Active or rollback Runtime endpoints may not be removed.",
        );
      }
      await rm(this.#instancePath(instanceId), { force: false });
    });
  }

  async #reference(instanceId: string): Promise<RuntimeEndpointReference> {
    const record = await this.readInstance(instanceId);
    const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    return { instanceId, recordSha256: sha256(bytes) };
  }

  async #verifyReference(
    reference: RuntimeEndpointReference,
  ): Promise<RuntimeEndpointRecord> {
    const record = await this.readInstance(reference.instanceId);
    const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    if (sha256(bytes) !== reference.recordSha256) {
      throw new Error(
        `Runtime endpoint reference ${reference.instanceId} no longer matches its immutable record.`,
      );
    }
    return record;
  }

  #instancePath(instanceId: string): string {
    assertIdentifier(instanceId, "Runtime instance ID");
    return join(this.#instancesDirectory, `${instanceId}.json`);
  }

  #assertExpectations(
    current: RuntimeEndpointPointer | null,
    input: RuntimeEndpointActivation,
  ): void {
    if (
      input.expectedGeneration !== undefined &&
      (current?.generation ?? null) !== input.expectedGeneration
    ) {
      throw new Error(
        `Runtime endpoint generation changed: expected ${String(input.expectedGeneration)}, observed ${String(current?.generation ?? null)}.`,
      );
    }
    if (
      input.expectedActiveInstanceId !== undefined &&
      (current?.active.instanceId ?? null) !== input.expectedActiveInstanceId
    ) {
      throw new Error(
        `Active Runtime instance changed: expected ${String(input.expectedActiveInstanceId)}, observed ${String(current?.active.instanceId ?? null)}.`,
      );
    }
  }

  async #readPointerInsideLock(): Promise<RuntimeEndpointPointer | null> {
    await this.#recoverPointerIfNeeded(true);
    try {
      return parsePointer(
        JSON.parse(await readFile(this.#pointerPath, "utf8")) as unknown,
      );
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
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
    const backups: { readonly path: string; readonly modifiedAt: number }[] =
      [];
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
    if (recover !== undefined) await rename(recover.path, this.#pointerPath);
    await Promise.all(
      backups.map((backup) => rm(backup.path, { force: true })),
    );
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
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
        } catch (statError) {
          if (nodeErrorCode(statError) === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadlineAt) {
          throw new Error(
            "Timed out waiting for the Runtime endpoint registry lock.",
          );
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    try {
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(this.#lockPath, { force: true }).catch(() => undefined);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const locked = () => this.#withLock(operation);
    const result = this.#queue.then(locked, locked);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
