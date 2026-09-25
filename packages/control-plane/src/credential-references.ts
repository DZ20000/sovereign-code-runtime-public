import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
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
import { TextDecoder } from "node:util";

import { RuntimeError } from "@sovereign/runtime-core";

export const CREDENTIAL_REFERENCE_SCHEMA_VERSION =
  "scr.credential-refs/v2" as const;
export const CREDENTIAL_REFERENCE_STATUS_SCHEMA_VERSION =
  "scr.credential-refs/status/v1" as const;

export const CREDENTIAL_SERVICES = [
  "anthropic",
  "github",
  "google",
  "groq",
  "mistral",
  "nebius",
  "openai",
  "openrouter",
  "xai",
] as const;
export type CredentialService = (typeof CREDENTIAL_SERVICES)[number];

export type CredentialReferenceSource =
  | { readonly kind: "github-cli" }
  | { readonly kind: "onepassword"; readonly reference: string }
  | { readonly kind: "aws-secrets-manager"; readonly reference: string };

type ProtectedCredentialReferenceSource =
  | { readonly kind: "github-cli" }
  | { readonly kind: "onepassword"; readonly protectedReference: string }
  | {
      readonly kind: "aws-secrets-manager";
      readonly protectedReference: string;
    };

interface CredentialReferenceRecord {
  readonly id: string;
  readonly label: string;
  readonly service: CredentialService;
  readonly source: ProtectedCredentialReferenceSource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CredentialReferenceDocument {
  readonly schemaVersion: typeof CREDENTIAL_REFERENCE_SCHEMA_VERSION;
  readonly entries: readonly CredentialReferenceRecord[];
}

export interface ResolvedCredentialReference {
  readonly id: string;
  readonly label: string;
  readonly service: CredentialService;
  readonly source: CredentialReferenceSource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CredentialReferenceMetadata {
  readonly id: string;
  readonly label: string;
  readonly service: CredentialService;
  readonly sourceKind: CredentialReferenceSource["kind"];
  readonly sourceDisplay: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CredentialReferenceStatus {
  readonly schemaVersion: typeof CREDENTIAL_REFERENCE_STATUS_SCHEMA_VERSION;
  readonly count: number;
  readonly entries: readonly CredentialReferenceMetadata[];
}

export interface RegisterCredentialReferenceInput {
  readonly id: string;
  readonly label: string;
  readonly service: CredentialService;
  readonly source: CredentialReferenceSource;
}

export interface ProtectedReferenceRestore {
  readonly value: string;
  readonly encoded: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u;
const MAX_FILE_BYTES = 131_072;
const MAX_ENTRIES = 64;
const MAX_PROTECTED_REFERENCE_BYTES = 65_536;
const SERVICE_SET = new Set<string>(CREDENTIAL_SERVICES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new RuntimeError("INVALID_INPUT", `${label} is invalid.`, 400);
  }
  return value;
}

function normalizeId(value: string): string {
  const normalized = requiredString(
    value.trim(),
    "Credential reference id",
    64,
  );
  if (!ID_PATTERN.test(normalized)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Credential reference id must start with a letter and contain only lowercase letters, digits, and hyphens.",
      400,
    );
  }
  return normalized;
}

function normalizeLabel(value: string): string {
  return requiredString(value.trim(), "Credential reference label", 120);
}

function normalizeService(value: unknown): CredentialService {
  const normalized = requiredString(value, "Credential service", 32);
  if (!SERVICE_SET.has(normalized)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `Unsupported credential service: ${normalized}`,
      400,
    );
  }
  return normalized as CredentialService;
}

function normalizeSource(value: unknown): CredentialReferenceSource {
  if (!isRecord(value)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Credential source must be an object.",
      400,
    );
  }
  const keys = Object.keys(value).sort();
  if (value.kind === "github-cli") {
    if (keys.length !== 1 || keys[0] !== "kind") {
      throw new RuntimeError(
        "INVALID_INPUT",
        "GitHub CLI credential source accepts no additional fields.",
        400,
      );
    }
    return { kind: "github-cli" };
  }
  if (value.kind === "onepassword") {
    if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "reference") {
      throw new RuntimeError(
        "INVALID_INPUT",
        "1Password credential source fields are invalid.",
        400,
      );
    }
    const reference = requiredString(
      value.reference,
      "1Password reference",
      1_024,
    );
    if (!/^op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+(?:\/[^/\s]+)?$/u.test(reference)) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "1Password reference must use a bounded op:// vault/item/field path.",
        400,
      );
    }
    return { kind: "onepassword", reference };
  }
  if (value.kind === "aws-secrets-manager") {
    if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "reference") {
      throw new RuntimeError(
        "INVALID_INPUT",
        "AWS Secrets Manager credential source fields are invalid.",
        400,
      );
    }
    const reference = requiredString(
      value.reference,
      "AWS Secrets Manager ARN",
      1_024,
    );
    if (
      !/^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/u.test(
        reference,
      )
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "AWS credential source must be a bounded Secrets Manager ARN.",
        400,
      );
    }
    return { kind: "aws-secrets-manager", reference };
  }
  throw new RuntimeError(
    "INVALID_INPUT",
    "Credential source kind is unsupported.",
    400,
  );
}

function normalizeProtectedReference(value: unknown): string {
  const encoded = requiredString(
    value,
    "Protected credential reference",
    MAX_PROTECTED_REFERENCE_BYTES,
  );
  if (Buffer.byteLength(encoded, "utf8") > MAX_PROTECTED_REFERENCE_BYTES) {
    throw new RuntimeError(
      "FILE_TOO_LARGE",
      "Protected credential reference is too large.",
      413,
    );
  }
  return encoded;
}

function normalizeProtectedSource(
  value: unknown,
): ProtectedCredentialReferenceSource {
  if (!isRecord(value)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Protected credential source must be an object.",
      400,
    );
  }
  const keys = Object.keys(value).sort();
  if (value.kind === "github-cli") {
    if (keys.length !== 1 || keys[0] !== "kind") {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Stored GitHub CLI credential source fields are invalid.",
        400,
      );
    }
    return { kind: "github-cli" };
  }
  if (value.kind === "onepassword" || value.kind === "aws-secrets-manager") {
    if (
      keys.length !== 2 ||
      keys[0] !== "kind" ||
      keys[1] !== "protectedReference"
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Stored protected credential source fields are invalid.",
        400,
      );
    }
    return {
      kind: value.kind,
      protectedReference: normalizeProtectedReference(value.protectedReference),
    };
  }
  throw new RuntimeError(
    "INVALID_INPUT",
    "Stored credential source kind is unsupported.",
    400,
  );
}

function validateSourceForService(
  service: CredentialService,
  source: { readonly kind: CredentialReferenceSource["kind"] },
): void {
  if (source.kind === "github-cli" && service !== "github") {
    throw new RuntimeError(
      "INVALID_INPUT",
      "GitHub CLI credential references may only be registered for the github service.",
      400,
    );
  }
}

function sourceDisplay(source: {
  readonly kind: CredentialReferenceSource["kind"];
}): string {
  switch (source.kind) {
    case "github-cli":
      return "GitHub CLI host token";
    case "onepassword":
      return "1Password reference";
    case "aws-secrets-manager":
      return "AWS Secrets Manager reference";
  }
}

function publicMetadata(
  record: CredentialReferenceRecord,
): CredentialReferenceMetadata {
  return {
    id: record.id,
    label: record.label,
    service: record.service,
    sourceKind: record.source.kind,
    sourceDisplay: sourceDisplay(record.source),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeRecord(value: unknown): CredentialReferenceRecord {
  if (!isRecord(value)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Credential reference entry must be an object.",
      400,
    );
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "createdAt",
    "id",
    "label",
    "service",
    "source",
    "updatedAt",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Credential reference entry fields are invalid.",
      400,
    );
  }
  const createdAt = requiredString(value.createdAt, "Credential createdAt", 64);
  const updatedAt = requiredString(value.updatedAt, "Credential updatedAt", 64);
  if (
    !Number.isFinite(Date.parse(createdAt)) ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Credential reference timestamps are invalid.",
      400,
    );
  }
  const service = normalizeService(value.service);
  const source = normalizeProtectedSource(value.source);
  validateSourceForService(service, source);
  return {
    id: normalizeId(requiredString(value.id, "Credential reference id", 64)),
    label: normalizeLabel(
      requiredString(value.label, "Credential reference label", 120),
    ),
    service,
    source,
    createdAt,
    updatedAt,
  };
}

function parseDocument(value: unknown): CredentialReferenceDocument {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CREDENTIAL_REFERENCE_SCHEMA_VERSION
  ) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Credential reference registry schema is invalid.",
      400,
    );
  }
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Credential reference registry entries are invalid.",
      400,
    );
  }
  const entries = value.entries.map(normalizeRecord);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new RuntimeError(
        "INVALID_INPUT",
        `Duplicate credential reference id: ${entry.id}`,
        400,
      );
    }
    ids.add(entry.id);
  }
  return {
    schemaVersion: CREDENTIAL_REFERENCE_SCHEMA_VERSION,
    entries: entries.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export interface CredentialReferenceStoreOptions {
  readonly storageRoot?: string;
  readonly workspaceRoot?: string;
  readonly protectReference?: (value: string) => Promise<string | null>;
  readonly restoreReference?: (
    encoded: string,
  ) => Promise<ProtectedReferenceRestore | null>;
}

function isContainedPath(root: string, candidate: string): boolean {
  const contained = relative(root, candidate);
  return (
    contained.length === 0 ||
    (contained !== ".." &&
      !contained.startsWith(`..${sep}`) &&
      !isAbsolute(contained))
  );
}

export class CredentialReferenceStore {
  readonly #path: string;
  readonly #storageRoot: string;
  readonly #workspaceRoot: string | undefined;
  readonly #protectReference:
    ((value: string) => Promise<string | null>) | undefined;
  readonly #restoreReference:
    | ((encoded: string) => Promise<ProtectedReferenceRestore | null>)
    | undefined;
  #loaded = false;
  #entries = new Map<string, CredentialReferenceRecord>();
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string, options: CredentialReferenceStoreOptions = {}) {
    this.#path = resolve(path);
    this.#storageRoot = resolve(options.storageRoot ?? dirname(this.#path));
    this.#workspaceRoot =
      options.workspaceRoot === undefined
        ? undefined
        : resolve(options.workspaceRoot);
    this.#protectReference = options.protectReference;
    this.#restoreReference = options.restoreReference;
    if (!isContainedPath(this.#storageRoot, this.#path)) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Credential reference registry must remain inside its storage root.",
        400,
      );
    }
    if (
      this.#workspaceRoot !== undefined &&
      isContainedPath(this.#workspaceRoot, this.#path)
    ) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Credential reference registry must remain outside the authorized workspace.",
        400,
      );
    }
  }

  status(): Promise<CredentialReferenceStatus> {
    return this.#serialized(async () => {
      await this.#load();
      const entries = [...this.#entries.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(publicMetadata);
      return {
        schemaVersion: CREDENTIAL_REFERENCE_STATUS_SCHEMA_VERSION,
        count: entries.length,
        entries,
      };
    });
  }

  register(
    input: RegisterCredentialReferenceInput,
  ): Promise<CredentialReferenceMetadata> {
    return this.#serialized(async () => {
      await this.#load();
      const id = normalizeId(input.id);
      const existing = this.#entries.get(id);
      const now = new Date().toISOString();
      const service = normalizeService(input.service);
      const source = normalizeSource(input.source);
      validateSourceForService(service, source);
      const protectedSource = await this.#protectSource(source);
      const record: CredentialReferenceRecord = {
        id,
        label: normalizeLabel(input.label),
        service,
        source: protectedSource,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.#entries.set(id, record);
      await this.#write();
      return publicMetadata(record);
    });
  }

  remove(
    id: string,
  ): Promise<{ readonly removed: boolean; readonly id: string }> {
    return this.#serialized(async () => {
      await this.#load();
      const normalized = normalizeId(id);
      const removed = this.#entries.delete(normalized);
      if (removed) {
        await this.#write();
      }
      return { removed, id: normalized };
    });
  }

  async resolve(id: string): Promise<ResolvedCredentialReference> {
    return await this.#serialized(async () => {
      await this.#load();
      const normalized = normalizeId(id);
      const record = this.#entries.get(normalized);
      if (record === undefined) {
        throw new RuntimeError(
          "PATH_NOT_FOUND",
          `Credential reference was not found: ${normalized}`,
          404,
        );
      }
      const restored = await this.#restoreSource(record.source);
      let current = record;
      if (restored.reprotectedSource !== null) {
        current = {
          ...record,
          source: restored.reprotectedSource,
          updatedAt: new Date().toISOString(),
        };
        this.#entries.set(normalized, current);
        await this.#write();
      }
      return {
        id: current.id,
        label: current.label,
        service: current.service,
        source: restored.source,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      };
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const run = async (): Promise<void> => {
      result = await operation();
    };
    const queued = this.#queue.then(run, run);
    this.#queue = queued.catch(() => undefined);
    return queued.then(() => result);
  }

  async #protectSource(
    source: CredentialReferenceSource,
  ): Promise<ProtectedCredentialReferenceSource> {
    if (source.kind === "github-cli") {
      return source;
    }
    if (this.#protectReference === undefined) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Protected storage is unavailable for credential references.",
        503,
      );
    }
    const encoded = await this.#protectReference(source.reference);
    if (encoded === null) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Protected storage rejected the credential reference.",
        503,
      );
    }
    const protectedReference = normalizeProtectedReference(encoded);
    if (
      protectedReference === source.reference ||
      protectedReference.includes(source.reference)
    ) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Protected storage returned an unsafe plaintext credential reference.",
        503,
      );
    }
    return {
      kind: source.kind,
      protectedReference,
    };
  }

  async #restoreSource(source: ProtectedCredentialReferenceSource): Promise<{
    readonly source: CredentialReferenceSource;
    readonly reprotectedSource: ProtectedCredentialReferenceSource | null;
  }> {
    if (source.kind === "github-cli") {
      return { source, reprotectedSource: null };
    }
    if (this.#restoreReference === undefined) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Protected credential-reference storage cannot be restored.",
        503,
      );
    }
    const restored = await this.#restoreReference(source.protectedReference);
    if (restored === null) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Protected credential reference could not be restored.",
        503,
      );
    }
    const normalized = normalizeSource({
      kind: source.kind,
      reference: restored.value,
    });
    const nextEncoded = normalizeProtectedReference(restored.encoded);
    return {
      source: normalized,
      reprotectedSource:
        nextEncoded === source.protectedReference
          ? null
          : { kind: source.kind, protectedReference: nextEncoded },
    };
  }

  async #canonicalRegistryPath(): Promise<string> {
    await Promise.all([
      mkdir(this.#storageRoot, { recursive: true }),
      mkdir(dirname(this.#path), { recursive: true }),
    ]);
    const [canonicalStorageRoot, canonicalParent] = await Promise.all([
      realpath(this.#storageRoot),
      realpath(dirname(this.#path)),
    ]);
    if (!isContainedPath(canonicalStorageRoot, canonicalParent)) {
      throw new RuntimeError(
        "PATH_ESCAPE",
        "Credential reference registry resolves outside its storage root.",
        400,
      );
    }
    if (this.#workspaceRoot !== undefined) {
      const canonicalWorkspaceRoot = await realpath(this.#workspaceRoot);
      if (isContainedPath(canonicalWorkspaceRoot, canonicalParent)) {
        throw new RuntimeError(
          "PATH_REJECTED",
          "Credential reference registry resolves inside the authorized workspace.",
          400,
        );
      }
    }
    const canonicalPath = join(canonicalParent, basename(this.#path));
    const info = await lstat(canonicalPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (info !== null && (info.isSymbolicLink() || !info.isFile())) {
      throw new RuntimeError(
        "PATH_SYMLINK",
        "Credential reference registry must be a direct regular file.",
        400,
      );
    }
    return canonicalPath;
  }

  async #load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    let document: CredentialReferenceDocument = {
      schemaVersion: CREDENTIAL_REFERENCE_SCHEMA_VERSION,
      entries: [],
    };
    const canonicalPath = await this.#canonicalRegistryPath();
    try {
      const bytes = await readFile(canonicalPath);
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new RuntimeError(
          "FILE_TOO_LARGE",
          "Credential reference registry is too large.",
          413,
        );
      }
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      document = parseDocument(JSON.parse(content) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    this.#entries = new Map(document.entries.map((entry) => [entry.id, entry]));
    this.#loaded = true;
  }

  async #write(): Promise<void> {
    const canonicalPath = await this.#canonicalRegistryPath();
    const document: CredentialReferenceDocument = {
      schemaVersion: CREDENTIAL_REFERENCE_SCHEMA_VERSION,
      entries: [...this.#entries.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    };
    const content = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new RuntimeError(
        "FILE_TOO_LARGE",
        "Credential reference registry exceeds its limit.",
        413,
      );
    }
    const temporary = `${canonicalPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, canonicalPath);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
