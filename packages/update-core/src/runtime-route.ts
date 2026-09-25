import { createHash, randomBytes } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export const RUNTIME_ROUTE_SCHEMA_VERSION = "scr.runtime-route/v1" as const;
export const RUNTIME_ROUTE_REVISION_SCHEMA_VERSION =
  "scr.runtime-route-revision/v1" as const;

export interface RuntimeRouteTarget {
  readonly instanceId: string;
  readonly releaseId: string;
  readonly routeId: string;
  readonly checkpointId: string;
  readonly fencingToken: string;
}

export interface RuntimeRouteRevision {
  readonly schemaVersion: typeof RUNTIME_ROUTE_REVISION_SCHEMA_VERSION;
  readonly generation: number;
  readonly previousRecordSha256: string | null;
  readonly activatedAt: number;
  readonly cutoverId: string;
  readonly operation: "bootstrap" | "switch" | "rollback" | "commit";
  readonly active: RuntimeRouteTarget;
  readonly previous: RuntimeRouteTarget | null;
  readonly recordSha256: string;
}

export interface RuntimeRouteRegistryOptions {
  readonly rootDirectory: string;
  readonly now?: () => number;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly maxRevisions?: number;
}

export interface RuntimeRouteMutationOptions {
  readonly cutoverId: string;
  readonly expectedGeneration: number | null;
}

const REVISION_FILE_PATTERN = /^revision-(\d{20})-([a-f0-9]{16})\.json$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,511})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_REVISION_BYTES = 64 * 1_024;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 15 * 60_000;
const DEFAULT_MAX_REVISIONS = 100_000;

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
  if (
    actual.length !== expected.length ||
    expected.some((key, index) => key !== actual[index])
  ) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !IDENTIFIER_PATTERN.test(value) ||
    value.includes("..") ||
    value.includes("//")
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} is invalid.`);
  }
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareOrdinal)
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseTarget(value: unknown, label: string): RuntimeRouteTarget {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertExactKeys(
    value,
    ["instanceId", "releaseId", "routeId", "checkpointId", "fencingToken"],
    label,
  );
  assertIdentifier(value.instanceId, `${label} instance ID`);
  assertIdentifier(value.releaseId, `${label} release ID`);
  assertIdentifier(value.routeId, `${label} route ID`);
  assertIdentifier(value.checkpointId, `${label} checkpoint ID`);
  assertIdentifier(value.fencingToken, `${label} fencing token`);
  return {
    instanceId: value.instanceId,
    releaseId: value.releaseId,
    routeId: value.routeId,
    checkpointId: value.checkpointId,
    fencingToken: value.fencingToken,
  };
}

function sameTarget(
  left: RuntimeRouteTarget,
  right: RuntimeRouteTarget,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.releaseId === right.releaseId &&
    left.routeId === right.routeId &&
    left.checkpointId === right.checkpointId &&
    left.fencingToken === right.fencingToken
  );
}

function revisionDigestPayload(
  revision: Omit<RuntimeRouteRevision, "recordSha256">,
): string {
  return canonicalJson(revision);
}

function parseRevision(value: unknown): RuntimeRouteRevision {
  if (!isRecord(value)) {
    throw new Error("Runtime route revision must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "generation",
      "previousRecordSha256",
      "activatedAt",
      "cutoverId",
      "operation",
      "active",
      "previous",
      "recordSha256",
    ],
    "Runtime route revision",
  );
  if (value.schemaVersion !== RUNTIME_ROUTE_REVISION_SCHEMA_VERSION) {
    throw new Error("Unsupported Runtime route revision schema version.");
  }
  assertSafeInteger(value.generation, "Runtime route generation", 1);
  assertSafeInteger(value.activatedAt, "Runtime route activatedAt", 0);
  assertIdentifier(value.cutoverId, "Runtime route cutover ID");
  if (
    value.operation !== "bootstrap" &&
    value.operation !== "switch" &&
    value.operation !== "rollback" &&
    value.operation !== "commit"
  ) {
    throw new Error("Runtime route operation is invalid.");
  }
  if (
    value.previousRecordSha256 !== null &&
    (typeof value.previousRecordSha256 !== "string" ||
      !SHA256_PATTERN.test(value.previousRecordSha256))
  ) {
    throw new Error("Runtime route previous-record digest is invalid.");
  }
  if (
    typeof value.recordSha256 !== "string" ||
    !SHA256_PATTERN.test(value.recordSha256)
  ) {
    throw new Error("Runtime route record digest is invalid.");
  }
  const active = parseTarget(value.active, "Active Runtime route");
  const previous =
    value.previous === null
      ? null
      : parseTarget(value.previous, "Previous Runtime route");
  if (previous !== null && sameTarget(active, previous)) {
    throw new Error("Active and previous Runtime routes may not be identical.");
  }
  if (value.operation === "bootstrap" && previous !== null) {
    throw new Error(
      "Bootstrap Runtime route may not contain a previous route.",
    );
  }
  if (value.operation === "rollback" && previous === null) {
    throw new Error(
      "Rollback Runtime route must preserve the displaced candidate.",
    );
  }
  if (value.operation === "commit" && previous !== null) {
    throw new Error("Committed Runtime route may not retain a previous route.");
  }
  const unsigned: Omit<RuntimeRouteRevision, "recordSha256"> = {
    schemaVersion: RUNTIME_ROUTE_REVISION_SCHEMA_VERSION,
    generation: value.generation,
    previousRecordSha256: value.previousRecordSha256,
    activatedAt: value.activatedAt,
    cutoverId: value.cutoverId,
    operation: value.operation,
    active,
    previous,
  };
  if (sha256(revisionDigestPayload(unsigned)) !== value.recordSha256) {
    throw new Error("Runtime route record digest does not match its payload.");
  }
  return { ...unsigned, recordSha256: value.recordSha256 };
}

function revisionFileName(revision: RuntimeRouteRevision): string {
  return `revision-${String(revision.generation).padStart(20, "0")}-${revision.recordSha256.slice(0, 16)}.json`;
}

function assertRevisionFileName(
  fileName: string,
  revision: RuntimeRouteRevision,
): void {
  const match = REVISION_FILE_PATTERN.exec(fileName);
  if (
    match === null ||
    Number(match[1]) !== revision.generation ||
    match[2] !== revision.recordSha256.slice(0, 16)
  ) {
    throw new Error(
      `Runtime route filename does not match its payload: ${fileName}.`,
    );
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return nodeErrorCode(error) === "EPERM";
  }
}

async function safeReadLock(path: string): Promise<{
  readonly pid: number;
  readonly acquiredAt: number;
} | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value)) return null;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1)
      return null;
    if (
      !Number.isSafeInteger(value.acquiredAt) ||
      (value.acquiredAt as number) < 0
    ) {
      return null;
    }
    return { pid: value.pid as number, acquiredAt: value.acquiredAt as number };
  } catch {
    return null;
  }
}

export class RuntimeRouteRegistry {
  readonly #rootDirectory: string;
  readonly #revisionsDirectory: string;
  readonly #lockPath: string;
  readonly #now: () => number;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  readonly #maxRevisions: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RuntimeRouteRegistryOptions) {
    if (
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.trim().length === 0 ||
      options.rootDirectory.length > 4_096
    ) {
      throw new Error("Runtime route registry root directory is invalid.");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#revisionsDirectory = join(this.#rootDirectory, "revisions");
    this.#lockPath = join(this.#rootDirectory, "route.lock");
    this.#now = options.now ?? Date.now;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.#maxRevisions = options.maxRevisions ?? DEFAULT_MAX_REVISIONS;
    for (const [label, value, maximum] of [
      ["Runtime route lock timeout", this.#lockTimeoutMs, 60_000],
      ["Runtime route stale-lock window", this.#staleLockMs, 24 * 60 * 60_000],
      ["Runtime route maximum revisions", this.#maxRevisions, 1_000_000],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(`${label} is invalid.`);
      }
    }
  }

  get rootDirectory(): string {
    return this.#rootDirectory;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#revisionsDirectory, { recursive: true });
    const rootInfo = await lstat(this.#rootDirectory);
    const revisionsInfo = await lstat(this.#revisionsDirectory);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      !revisionsInfo.isDirectory() ||
      revisionsInfo.isSymbolicLink()
    ) {
      throw new Error("Runtime route registry must use real directories.");
    }
  }

  async readAll(): Promise<readonly RuntimeRouteRevision[]> {
    await this.initialize();
    const directoryEntries = await readdir(this.#revisionsDirectory, {
      withFileTypes: true,
    });
    const files: string[] = [];
    for (const entry of directoryEntries) {
      if (entry.name.startsWith(".pending-") && entry.name.endsWith(".tmp")) {
        continue;
      }
      if (!entry.isFile() || REVISION_FILE_PATTERN.exec(entry.name) === null) {
        throw new Error(
          `Runtime route registry contains an unexpected entry: ${entry.name}.`,
        );
      }
      files.push(entry.name);
    }
    files.sort(compareOrdinal);
    if (files.length > this.#maxRevisions) {
      throw new Error("Runtime route registry exceeds its revision limit.");
    }
    const revisions: RuntimeRouteRevision[] = [];
    let previousRecordSha256: string | null = null;
    for (const [index, fileName] of files.entries()) {
      const path = join(this.#revisionsDirectory, fileName);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        throw new Error(
          `Runtime route revision is not a private regular file: ${fileName}.`,
        );
      }
      if (info.size < 2 || info.size > MAX_REVISION_BYTES) {
        throw new Error(
          `Runtime route revision has an invalid size: ${fileName}.`,
        );
      }
      const revision = parseRevision(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
      assertRevisionFileName(fileName, revision);
      if (revision.generation !== index + 1) {
        throw new Error("Runtime route generations are not contiguous.");
      }
      if (revision.previousRecordSha256 !== previousRecordSha256) {
        throw new Error("Runtime route hash chain is invalid.");
      }
      assertRevisionTransition(revisions.at(-1) ?? null, revision);
      previousRecordSha256 = revision.recordSha256;
      revisions.push(revision);
    }
    return revisions;
  }

  async readCurrent(): Promise<RuntimeRouteRevision | null> {
    return (await this.readAll()).at(-1) ?? null;
  }

  async bootstrap(
    active: RuntimeRouteTarget,
    options: RuntimeRouteMutationOptions,
  ): Promise<RuntimeRouteRevision> {
    const parsed = parseTarget(active, "Bootstrap Runtime route");
    return await this.#appendMutation(options, (current) => {
      if (current !== null) {
        if (sameTarget(current.active, parsed)) return current;
        throw new Error("Runtime route registry is already bootstrapped.");
      }
      return {
        operation: "bootstrap" as const,
        active: parsed,
        previous: null,
      };
    });
  }

  async switchTo(
    candidate: RuntimeRouteTarget,
    options: RuntimeRouteMutationOptions,
  ): Promise<RuntimeRouteRevision> {
    const parsed = parseTarget(candidate, "Candidate Runtime route");
    return await this.#appendMutation(options, (current) => {
      if (current === null) {
        throw new Error(
          "Runtime route registry must be bootstrapped before switching.",
        );
      }
      if (sameTarget(current.active, parsed)) return current;
      if (current.active.instanceId === parsed.instanceId) {
        throw new Error(
          "Runtime candidate may not reuse the active instance ID.",
        );
      }
      if (current.active.routeId === parsed.routeId) {
        throw new Error("Runtime candidate may not reuse the active route ID.");
      }
      if (current.active.fencingToken === parsed.fencingToken) {
        throw new Error("Runtime candidate requires a new fencing token.");
      }
      return {
        operation: "switch" as const,
        active: parsed,
        previous: current.active,
      };
    });
  }

  async rollback(
    options: RuntimeRouteMutationOptions,
  ): Promise<RuntimeRouteRevision> {
    return await this.#appendMutation(options, (current) => {
      if (current === null || current.previous === null) {
        throw new Error("No previous Runtime route is available for rollback.");
      }
      return {
        operation: "rollback" as const,
        active: current.previous,
        previous: current.active,
      };
    });
  }

  async commit(
    options: RuntimeRouteMutationOptions,
  ): Promise<RuntimeRouteRevision> {
    return await this.#appendMutation(options, (current) => {
      if (current === null) {
        throw new Error(
          "Runtime route registry has no active route to commit.",
        );
      }
      if (current.previous === null && current.operation === "commit") {
        return current;
      }
      return {
        operation: "commit" as const,
        active: current.active,
        previous: null,
      };
    });
  }

  async #appendMutation(
    options: RuntimeRouteMutationOptions,
    create: (current: RuntimeRouteRevision | null) =>
      | RuntimeRouteRevision
      | {
          readonly operation: RuntimeRouteRevision["operation"];
          readonly active: RuntimeRouteTarget;
          readonly previous: RuntimeRouteTarget | null;
        },
  ): Promise<RuntimeRouteRevision> {
    assertIdentifier(options.cutoverId, "Runtime route cutover ID");
    if (
      options.expectedGeneration !== null &&
      (!Number.isSafeInteger(options.expectedGeneration) ||
        options.expectedGeneration < 1)
    ) {
      throw new Error("Runtime route expected generation is invalid.");
    }
    return await this.#serialize(
      async () =>
        await this.#withLock(async () => {
          const revisions = await this.readAll();
          const current = revisions.at(-1) ?? null;
          const observedGeneration = current?.generation ?? null;
          if (observedGeneration !== options.expectedGeneration) {
            throw new Error(
              `Runtime route generation changed: expected ${String(options.expectedGeneration)}, observed ${String(observedGeneration)}.`,
            );
          }
          const next = create(current);
          if ("recordSha256" in next) return next;
          if (revisions.length >= this.#maxRevisions) {
            throw new Error(
              "Runtime route registry reached its revision limit.",
            );
          }
          const unsigned: Omit<RuntimeRouteRevision, "recordSha256"> = {
            schemaVersion: RUNTIME_ROUTE_REVISION_SCHEMA_VERSION,
            generation: revisions.length + 1,
            previousRecordSha256: current?.recordSha256 ?? null,
            activatedAt: this.#now(),
            cutoverId: options.cutoverId,
            operation: next.operation,
            active: next.active,
            previous: next.previous,
          };
          const revision: RuntimeRouteRevision = {
            ...unsigned,
            recordSha256: sha256(revisionDigestPayload(unsigned)),
          };
          assertRevisionTransition(current, revision);
          await this.#writeRevision(revision);
          return revision;
        }),
    );
  }

  async #writeRevision(revision: RuntimeRouteRevision): Promise<void> {
    const bytes = Buffer.from(`${canonicalJson(revision)}\n`, "utf8");
    if (bytes.length > MAX_REVISION_BYTES) {
      throw new Error("Runtime route revision exceeds its size limit.");
    }
    const temporaryPath = join(
      this.#revisionsDirectory,
      `.pending-${revision.generation}-${randomBytes(8).toString("hex")}.tmp`,
    );
    const finalPath = join(
      this.#revisionsDirectory,
      revisionFileName(revision),
    );
    let handle: FileHandle | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const deadline = Date.now() + this.#lockTimeoutMs;
    let handle: FileHandle | null = null;
    while (handle === null) {
      try {
        handle = await open(this.#lockPath, "wx", 0o600);
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        const lockInfo = await safeReadLock(this.#lockPath);
        const lockStat = await stat(this.#lockPath).catch(
          (statError: unknown) => {
            if (nodeErrorCode(statError) === "ENOENT") return null;
            throw statError;
          },
        );
        if (lockStat === null) continue;
        const lockAge = Date.now() - (lockInfo?.acquiredAt ?? lockStat.mtimeMs);
        const ownerIsGone = lockInfo === null || !processIsAlive(lockInfo.pid);
        if (lockAge > this.#staleLockMs && ownerIsGone) {
          await rm(this.#lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            "Timed out waiting for the Runtime route registry lock.",
          );
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    try {
      await handle.writeFile(
        `${JSON.stringify({
          schemaVersion: RUNTIME_ROUTE_SCHEMA_VERSION,
          pid: process.pid,
          acquiredAt: Date.now(),
          nonce: randomBytes(8).toString("hex"),
        })}\n`,
        { encoding: "utf8" },
      );
      await handle.sync();
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(this.#lockPath, { force: true }).catch(() => undefined);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function assertRevisionTransition(
  previous: RuntimeRouteRevision | null,
  next: RuntimeRouteRevision,
): void {
  if (previous === null) {
    if (
      next.generation !== 1 ||
      next.previousRecordSha256 !== null ||
      next.operation !== "bootstrap" ||
      next.previous !== null
    ) {
      throw new Error(
        "First Runtime route revision must be a bootstrap revision.",
      );
    }
    return;
  }
  if (
    next.generation !== previous.generation + 1 ||
    next.previousRecordSha256 !== previous.recordSha256
  ) {
    throw new Error("Runtime route revision chain is not contiguous.");
  }
  switch (next.operation) {
    case "bootstrap":
      throw new Error("Runtime route may be bootstrapped only once.");
    case "switch":
      if (
        next.previous === null ||
        !sameTarget(next.previous, previous.active)
      ) {
        throw new Error(
          "Runtime route switch does not retain the previous active route.",
        );
      }
      break;
    case "rollback":
      if (
        previous.previous === null ||
        !sameTarget(next.active, previous.previous) ||
        next.previous === null ||
        !sameTarget(next.previous, previous.active)
      ) {
        throw new Error(
          "Runtime route rollback does not invert the previous switch.",
        );
      }
      break;
    case "commit":
      if (!sameTarget(next.active, previous.active) || next.previous !== null) {
        throw new Error("Runtime route commit changes the active route.");
      }
      break;
  }
}
