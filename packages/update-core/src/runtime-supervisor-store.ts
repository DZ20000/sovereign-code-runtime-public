import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  parseRuntimeSupervisorState,
  type RuntimeSupervisorState,
} from "./runtime-supervisor-state.js";

export const RUNTIME_SUPERVISOR_LEDGER_ENTRY_SCHEMA_VERSION =
  "scr.runtime-supervisor-ledger-entry/v1" as const;

const ENTRY_NAME_PATTERN = /^entry-(\d{16})\.json$/u;
const PENDING_NAME_PATTERN = /^\.pending-[A-Za-z0-9-]{20,80}\.json$/u;
const ABANDONED_PENDING_AGE_MS = 5 * 60 * 1_000;
const TRANSIENT_LINK_RETRY_ATTEMPTS = 10;
const TRANSIENT_LINK_RETRY_DELAY_MS = 10;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_LEDGER_ENTRIES = 100_000;
const ENTRY_KEYS = [
  "schemaVersion",
  "revision",
  "previousEntrySha256",
  "state",
] as const;

export type RuntimeSupervisorStoreErrorCode =
  | "INVALID_PATH"
  | "UNSAFE_DIRECTORY"
  | "INVALID_INVENTORY"
  | "LEDGER_EMPTY"
  | "LEDGER_CORRUPT"
  | "CONFLICT"
  | "PUBLISH_FAILED";

export class RuntimeSupervisorStoreError extends Error {
  readonly code: RuntimeSupervisorStoreErrorCode;

  constructor(
    code: RuntimeSupervisorStoreErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "RuntimeSupervisorStoreError";
    this.code = code;
  }
}

export interface RuntimeSupervisorStoreSnapshot {
  readonly revision: number;
  readonly entrySha256: string;
  readonly state: RuntimeSupervisorState;
}

export interface RuntimeSupervisorStoreExpectation {
  readonly revision: number;
  readonly entrySha256: string;
}

export interface RuntimeSupervisorStoreOptions {
  readonly directoryPath: string;
  readonly requireDirectorySync?: boolean;
}

interface RuntimeSupervisorLedgerEntry {
  readonly schemaVersion: typeof RUNTIME_SUPERVISOR_LEDGER_ENTRY_SCHEMA_VERSION;
  readonly revision: number;
  readonly previousEntrySha256: string | null;
  readonly state: RuntimeSupervisorState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expectedKeys.length &&
    actual.every((key) => expectedKeys.includes(key)) &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) {
        output[key] = canonicalize(item);
      }
    }
    return output;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function validateDirectoryInput(value: string): string {
  const localWindowsPath =
    process.platform !== "win32" ||
    (/^[A-Za-z]:[\\/]/u.test(value) &&
      !value.startsWith("\\\\") &&
      !value.startsWith("\\?\\") &&
      !value.startsWith("\\.\\"));
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    !localWindowsPath
  ) {
    throw new RuntimeSupervisorStoreError(
      "INVALID_PATH",
      "Runtime supervisor ledger path must be a bounded absolute local path.",
    );
  }
  return resolve(value);
}

async function ensureRealDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path).catch((error: unknown) => {
    throw new RuntimeSupervisorStoreError(
      "UNSAFE_DIRECTORY",
      "Runtime supervisor ledger directory is unavailable.",
      { cause: error },
    );
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RuntimeSupervisorStoreError(
      "UNSAFE_DIRECTORY",
      "Runtime supervisor ledger path must be a real directory.",
    );
  }
  const canonical = await realpath(path);
  const comparable = (input: string): string =>
    process.platform === "win32"
      ? resolve(input)
          .replace(/^\\\\\?\\/u, "")
          .toLowerCase()
      : resolve(input);
  if (comparable(canonical) !== comparable(path)) {
    throw new RuntimeSupervisorStoreError(
      "UNSAFE_DIRECTORY",
      "Runtime supervisor ledger path may not traverse a symbolic link or junction.",
    );
  }
  return canonical;
}

function entryName(revision: number): string {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > MAX_LEDGER_ENTRIES
  ) {
    throw new RuntimeSupervisorStoreError(
      "LEDGER_CORRUPT",
      "Runtime supervisor ledger revision is outside its bound.",
    );
  }
  return `entry-${String(revision).padStart(16, "0")}.json`;
}

function parseEntry(
  value: unknown,
  expectedRevision: number,
): RuntimeSupervisorLedgerEntry {
  if (!isRecord(value) || !exactKeys(value, ENTRY_KEYS)) {
    throw new RuntimeSupervisorStoreError(
      "LEDGER_CORRUPT",
      "Runtime supervisor ledger entry shape is invalid.",
    );
  }
  if (
    value.schemaVersion !== RUNTIME_SUPERVISOR_LEDGER_ENTRY_SCHEMA_VERSION ||
    value.revision !== expectedRevision ||
    (value.previousEntrySha256 !== null &&
      (typeof value.previousEntrySha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.previousEntrySha256)))
  ) {
    throw new RuntimeSupervisorStoreError(
      "LEDGER_CORRUPT",
      "Runtime supervisor ledger entry metadata is invalid.",
    );
  }
  return {
    schemaVersion: RUNTIME_SUPERVISOR_LEDGER_ENTRY_SCHEMA_VERSION,
    revision: expectedRevision,
    previousEntrySha256: value.previousEntrySha256,
    state: parseRuntimeSupervisorState(value.state),
  };
}

async function readUnsharedEntryMetadata(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  for (let attempt = 0; attempt <= TRANSIENT_LINK_RETRY_ATTEMPTS; attempt += 1) {
    const info = await lstat(path).catch((error: unknown) => {
      throw new RuntimeSupervisorStoreError(
        "LEDGER_CORRUPT",
        "Runtime supervisor ledger entry is unavailable.",
        { cause: error },
      );
    });
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.size < 1 ||
      info.size > MAX_ENTRY_BYTES
    ) {
      throw new RuntimeSupervisorStoreError(
        "LEDGER_CORRUPT",
        "Runtime supervisor ledger entry is not a bounded regular file.",
      );
    }
    if (info.nlink === 1) return info;
    if (info.nlink === 2 && attempt < TRANSIENT_LINK_RETRY_ATTEMPTS) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, TRANSIENT_LINK_RETRY_DELAY_MS),
      );
      continue;
    }
    throw new RuntimeSupervisorStoreError(
      "LEDGER_CORRUPT",
      "Runtime supervisor ledger entry is not an unshared regular file.",
    );
  }
  throw new RuntimeSupervisorStoreError(
    "LEDGER_CORRUPT",
    "Runtime supervisor ledger entry remained shared during verification.",
  );
}

async function readStableFile(path: string): Promise<Buffer> {
  const before = await readUnsharedEntryMetadata(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== before.size ||
      (before.dev !== 0 && opened.dev !== 0 && before.dev !== opened.dev) ||
      (before.ino !== 0 && opened.ino !== 0 && before.ino !== opened.ino)
    ) {
      throw new RuntimeSupervisorStoreError(
        "LEDGER_CORRUPT",
        "Runtime supervisor ledger entry changed while opening.",
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      (opened.dev !== 0 && after.dev !== 0 && opened.dev !== after.dev) ||
      (opened.ino !== 0 && after.ino !== 0 && opened.ino !== after.ino)
    ) {
      throw new RuntimeSupervisorStoreError(
        "LEDGER_CORRUPT",
        "Runtime supervisor ledger entry changed while reading.",
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof RuntimeSupervisorStoreError) {
      throw error;
    }
    throw new RuntimeSupervisorStoreError(
      "LEDGER_CORRUPT",
      "Runtime supervisor ledger entry could not be read safely.",
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class RuntimeSupervisorStore {
  readonly #directoryPath: string;
  readonly #entriesPath: string;
  readonly #requireDirectorySync: boolean;

  constructor(options: RuntimeSupervisorStoreOptions) {
    this.#directoryPath = validateDirectoryInput(options.directoryPath);
    this.#entriesPath = join(this.#directoryPath, "entries");
    this.#requireDirectorySync = options.requireDirectorySync === true;
  }

  get directoryPath(): string {
    return this.#directoryPath;
  }

  async initialize(
    stateInput: RuntimeSupervisorState,
  ): Promise<RuntimeSupervisorStoreSnapshot> {
    const state = parseRuntimeSupervisorState(stateInput);
    const inventory = await this.#inventory();
    if (inventory.length !== 0) {
      throw new RuntimeSupervisorStoreError(
        "CONFLICT",
        "Runtime supervisor ledger is already initialized.",
      );
    }
    return await this.#publish(state, null);
  }

  async load(): Promise<RuntimeSupervisorStoreSnapshot> {
    const inventory = await this.#inventory();
    if (inventory.length === 0) {
      throw new RuntimeSupervisorStoreError(
        "LEDGER_EMPTY",
        "Runtime supervisor ledger is empty.",
      );
    }
    let previousSha256: string | null = null;
    let snapshot: RuntimeSupervisorStoreSnapshot | null = null;
    for (let index = 0; index < inventory.length; index += 1) {
      const revision = index + 1;
      const name = inventory[index];
      if (name !== entryName(revision)) {
        throw new RuntimeSupervisorStoreError(
          "LEDGER_CORRUPT",
          "Runtime supervisor ledger revisions are not contiguous.",
        );
      }
      const bytes = await readStableFile(join(this.#entriesPath, name));
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        throw new RuntimeSupervisorStoreError(
          "LEDGER_CORRUPT",
          "Runtime supervisor ledger entry is not valid JSON.",
          { cause: error },
        );
      }
      const entry = parseEntry(value, revision);
      if (entry.previousEntrySha256 !== previousSha256) {
        throw new RuntimeSupervisorStoreError(
          "LEDGER_CORRUPT",
          "Runtime supervisor ledger hash chain is broken.",
        );
      }
      const entrySha256 = sha256(bytes);
      previousSha256 = entrySha256;
      snapshot = {
        revision,
        entrySha256,
        state: entry.state,
      };
    }
    if (snapshot === null) {
      throw new RuntimeSupervisorStoreError(
        "LEDGER_EMPTY",
        "Runtime supervisor ledger is empty.",
      );
    }
    return snapshot;
  }

  async append(
    stateInput: RuntimeSupervisorState,
    expected: RuntimeSupervisorStoreExpectation,
  ): Promise<RuntimeSupervisorStoreSnapshot> {
    if (
      !Number.isSafeInteger(expected.revision) ||
      expected.revision < 1 ||
      typeof expected.entrySha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(expected.entrySha256)
    ) {
      throw new RuntimeSupervisorStoreError(
        "CONFLICT",
        "Runtime supervisor ledger expectation is invalid.",
      );
    }
    const current = await this.load();
    if (
      current.revision !== expected.revision ||
      current.entrySha256 !== expected.entrySha256
    ) {
      throw new RuntimeSupervisorStoreError(
        "CONFLICT",
        "Runtime supervisor ledger compare-and-swap expectation is stale.",
      );
    }
    const state = parseRuntimeSupervisorState(stateInput);
    if (
      state.epoch < current.state.epoch ||
      Date.parse(state.updatedAt) < Date.parse(current.state.updatedAt)
    ) {
      throw new RuntimeSupervisorStoreError(
        "CONFLICT",
        "Runtime supervisor state regresses the persisted epoch or timestamp.",
      );
    }
    if (canonicalJson(state) === canonicalJson(current.state)) {
      throw new RuntimeSupervisorStoreError(
        "CONFLICT",
        "Runtime supervisor state is unchanged.",
      );
    }
    return await this.#publish(state, current);
  }

  async #inventory(): Promise<readonly string[]> {
    const root = await ensureRealDirectory(this.#directoryPath);
    const entries = await ensureRealDirectory(this.#entriesPath);
    const contained = relative(root, entries);
    if (
      contained === ".." ||
      contained.startsWith(".." + sep) ||
      isAbsolute(contained)
    ) {
      throw new RuntimeSupervisorStoreError(
        "UNSAFE_DIRECTORY",
        "Runtime supervisor entries directory escapes its root.",
      );
    }
    const names = await readdir(entries);
    const published: string[] = [];
    let pendingCount = 0;
    for (const name of names) {
      if (ENTRY_NAME_PATTERN.test(name)) {
        published.push(name);
        continue;
      }
      if (PENDING_NAME_PATTERN.test(name)) {
        pendingCount += 1;
        if (pendingCount > 64) {
          throw new RuntimeSupervisorStoreError(
            "INVALID_INVENTORY",
            "Runtime supervisor ledger has too many abandoned pending entries.",
          );
        }
        const path = join(entries, name);
        const info = await lstat(path).catch((error: unknown) => {
          if (hasErrorCode(error, "ENOENT")) return null;
          throw new RuntimeSupervisorStoreError(
            "INVALID_INVENTORY",
            "Runtime supervisor pending entry could not be inspected safely.",
            { cause: error },
          );
        });
        if (info === null) {
          continue;
        }
        if (
          info.isSymbolicLink() ||
          !info.isFile() ||
          info.nlink < 1 ||
          info.nlink > 2 ||
          info.size > MAX_ENTRY_BYTES
        ) {
          throw new RuntimeSupervisorStoreError(
            "INVALID_INVENTORY",
            "Runtime supervisor pending entry is unsafe.",
          );
        }
        const pendingAgeMs = Date.now() - info.mtimeMs;
        if (pendingAgeMs < ABANDONED_PENDING_AGE_MS) {
          continue;
        }
        await unlink(path).catch((error: unknown) => {
          if (hasErrorCode(error, "ENOENT")) return;
          throw new RuntimeSupervisorStoreError(
            "INVALID_INVENTORY",
            "Runtime supervisor pending entry could not be removed safely.",
            { cause: error },
          );
        });
        continue;
      }
      throw new RuntimeSupervisorStoreError(
        "INVALID_INVENTORY",
        `Runtime supervisor ledger contains an unexpected entry: ${name}`,
      );
    }
    if (published.length > MAX_LEDGER_ENTRIES) {
      throw new RuntimeSupervisorStoreError(
        "LEDGER_CORRUPT",
        "Runtime supervisor ledger exceeds its revision bound.",
      );
    }
    return published.sort();
  }

  async #publish(
    state: RuntimeSupervisorState,
    previous: RuntimeSupervisorStoreSnapshot | null,
  ): Promise<RuntimeSupervisorStoreSnapshot> {
    await this.#inventory();
    const revision = (previous?.revision ?? 0) + 1;
    const entry: RuntimeSupervisorLedgerEntry = {
      schemaVersion: RUNTIME_SUPERVISOR_LEDGER_ENTRY_SCHEMA_VERSION,
      revision,
      previousEntrySha256: previous?.entrySha256 ?? null,
      state,
    };
    const bytes = Buffer.from(canonicalJson(entry), "utf8");
    if (bytes.byteLength > MAX_ENTRY_BYTES) {
      throw new RuntimeSupervisorStoreError(
        "PUBLISH_FAILED",
        "Runtime supervisor ledger entry exceeds its byte bound.",
      );
    }
    const pendingName = `.pending-${randomUUID()}.json`;
    const pendingPath = join(this.#entriesPath, pendingName);
    const finalPath = join(this.#entriesPath, entryName(revision));
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let linked = false;
    try {
      handle = await open(pendingPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(pendingPath, finalPath);
        linked = true;
      } catch (error) {
        const competingRevisionExists = await lstat(finalPath)
          .then(() => true)
          .catch((inspectionError: unknown) => {
            if (hasErrorCode(inspectionError, "ENOENT")) return false;
            throw new RuntimeSupervisorStoreError(
              "PUBLISH_FAILED",
              "Runtime supervisor revision collision could not be inspected safely.",
              { cause: inspectionError },
            );
          });
        if (hasErrorCode(error, "EEXIST") || competingRevisionExists) {
          throw new RuntimeSupervisorStoreError(
            "CONFLICT",
            "Another writer published the Runtime supervisor revision first.",
            { cause: error },
          );
        }
        throw new RuntimeSupervisorStoreError(
          "PUBLISH_FAILED",
          "Runtime supervisor revision could not be published atomically.",
          { cause: error },
        );
      }
      await unlink(pendingPath);
      const directorySynced = await syncDirectory(this.#entriesPath);
      if (this.#requireDirectorySync && !directorySynced) {
        throw new RuntimeSupervisorStoreError(
          "PUBLISH_FAILED",
          "Runtime supervisor ledger directory durability could not be confirmed.",
        );
      }
      const snapshot = await this.load();
      if (snapshot.revision !== revision) {
        throw new RuntimeSupervisorStoreError(
          "PUBLISH_FAILED",
          "Runtime supervisor ledger head changed during publication verification.",
        );
      }
      return snapshot;
    } catch (error) {
      if (error instanceof RuntimeSupervisorStoreError) {
        throw error;
      }
      throw new RuntimeSupervisorStoreError(
        "PUBLISH_FAILED",
        "Runtime supervisor ledger publication failed.",
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
      if (!linked) {
        await unlink(pendingPath).catch(() => undefined);
      }
    }
  }
}
