import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
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

import { RuntimeError } from "@sovereign/runtime-core";

import {
  SandboxArtifactCollector,
  type SandboxCollectionResult as CollectedSandboxArtifacts,
} from "./sandbox-artifact-collector.js";
import {
  defaultSandboxProcessRunner,
  type SandboxProcessResult,
  type SandboxProcessRunner,
} from "./sandbox-process-runner.js";

export { SANDBOX_COLLECTION_SCHEMA_VERSION } from "./sandbox-artifact-collector.js";
export type {
  SandboxCollectedRef,
  SandboxCollectionResult,
} from "./sandbox-artifact-collector.js";
export type {
  SandboxProcessResult,
  SandboxProcessRunner,
} from "./sandbox-process-runner.js";

export const SANDBOX_REGISTRY_SCHEMA_VERSION = "scr.sandboxes/v1" as const;
export const SANDBOX_CAPABILITIES_SCHEMA_VERSION =
  "scr.sandbox-capabilities/v1" as const;
export const SANDBOX_LIST_SCHEMA_VERSION = "scr.sandbox-list/v1" as const;
export const SBX_REVIEWED_VERSION = "0.39.0" as const;
export const SBX_REVIEWED_WINDOWS_X64_SHA256 =
  "b064711a10f22363953e90eae926dbd9d96419e601f9308cd9d1102e3d81ccbf" as const;

const MAX_REGISTRY_BYTES = 131_072;
const MAX_SANDBOXES_PER_WORKSPACE = 32;
const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;
const MAX_EXECUTABLE_BYTES = 512 * 1_024 * 1_024;
const SANDBOX_NAME_PATTERN = /^sovereign-[a-z0-9][a-z0-9-]{0,38}-[a-f0-9]{8}$/u;
const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SandboxCapabilities {
  readonly schemaVersion: typeof SANDBOX_CAPABILITIES_SCHEMA_VERSION;
  readonly provider: "docker-sbx";
  readonly available: boolean;
  readonly trusted: boolean;
  readonly compatible: boolean;
  readonly authenticated: boolean;
  readonly executable: string;
  readonly version: string | null;
  readonly expectedVersion: string;
  readonly executableSha256: string | null;
  readonly expectedExecutableSha256: string;
  readonly loginRequired: boolean;
  readonly reason: string | null;
  readonly guarantees: {
    readonly microVm: true;
    readonly privateClone: true;
    readonly hostRepositoryReadOnly: true;
    readonly hostWorkingTree: "unchanged";
    readonly hostGitConfig: "sandbox-remote-managed";
    readonly network: "deny-all";
    readonly hostShell: false;
    readonly privilegedExec: false;
    readonly hostPathCopy: false;
  };
}

interface SandboxRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly workspaceFingerprint: string;
  readonly createdAt: string;
  readonly cpus: number;
  readonly memoryMiB: number;
}

interface SandboxRegistryDocument {
  readonly schemaVersion: typeof SANDBOX_REGISTRY_SCHEMA_VERSION;
  readonly entries: readonly SandboxRegistryEntry[];
}

export interface SandboxSummary {
  readonly id: string;
  readonly label: string;
  readonly provider: "docker-sbx";
  readonly status: string;
  readonly createdAt: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly workspaceFingerprint: string;
  readonly isolation: {
    readonly mode: "clone";
    readonly hostRepository: "read-only";
    readonly hostWorkingTree: "unchanged";
    readonly hostGitConfig: "sandbox-remote-managed";
    readonly network: "deny-all";
  };
}

export interface SandboxListResult {
  readonly schemaVersion: typeof SANDBOX_LIST_SCHEMA_VERSION;
  readonly count: number;
  readonly sandboxes: readonly SandboxSummary[];
}

export interface SandboxCreateInput {
  readonly label: string;
  readonly cpus: number;
  readonly memoryMiB: number;
}

export interface SandboxManagerOptions {
  readonly workspaceRoot: string;
  readonly registryPath: string;
  readonly storageRoot?: string;
  readonly executablePath?: string;
  readonly expectedVersion?: string;
  readonly expectedExecutableSha256?: string;
  readonly runner?: SandboxProcessRunner;
  readonly gitRunner?: SandboxProcessRunner;
}

function safeText(value: unknown, maximum = 1_000): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/[\0\r\n]+/gu, " ")
    .slice(0, maximum);
}

async function sha256File(path: string, size: number): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_EXECUTABLE_BYTES) {
    throw new RuntimeError(
      "FILE_TOO_LARGE",
      "Docker Sandboxes executable size is outside the reviewed bound.",
      413,
    );
  }
  const hash = createHash("sha256");
  let bytesRead = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += buffer.byteLength;
    if (bytesRead > size || bytesRead > MAX_EXECUTABLE_BYTES) {
      throw new RuntimeError(
        "FILE_TOO_LARGE",
        "Docker Sandboxes executable changed while it was being verified.",
        413,
      );
    }
    hash.update(buffer);
  }
  if (bytesRead !== size) {
    throw new RuntimeError(
      "INVALID_HASH",
      "Docker Sandboxes executable changed while it was being verified.",
      409,
    );
  }
  return hash.digest("hex");
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

function normalizeLabel(value: string): string {
  const label = value.trim();
  if (label.length === 0 || label.length > 80 || /[\0\r\n]/u.test(label)) {
    throw new RuntimeError("INVALID_INPUT", "Sandbox label is invalid.", 400);
  }
  return label;
}

function normalizeId(value: string): string {
  const id = value.trim().toLocaleLowerCase("en-US");
  if (!ID_PATTERN.test(id)) {
    throw new RuntimeError("INVALID_INPUT", "Sandbox id is invalid.", 400);
  }
  return id;
}

function slugForLabel(label: string): string {
  const slug = label
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 39)
    .replace(/-+$/u, "");
  return slug.length === 0 ? "job" : slug;
}

function normalizeRegistryEntry(value: unknown): SandboxRegistryEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Sandbox registry entry is invalid.",
      400,
    );
  }
  const record = value as Record<string, unknown>;
  const id = normalizeId(String(record.id ?? ""));
  const name = String(record.name ?? "");
  if (!SANDBOX_NAME_PATTERN.test(name)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Sandbox registry name is invalid.",
      400,
    );
  }
  const workspaceFingerprint = String(record.workspaceFingerprint ?? "");
  if (!/^[a-f0-9]{64}$/u.test(workspaceFingerprint)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Sandbox workspace fingerprint is invalid.",
      400,
    );
  }
  const createdAt = String(record.createdAt ?? "");
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Sandbox createdAt is invalid.",
      400,
    );
  }
  const cpus = Number(record.cpus);
  const memoryMiB = Number(record.memoryMiB);
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 32) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Sandbox CPU allocation is invalid.",
      400,
    );
  }
  if (!Number.isInteger(memoryMiB) || memoryMiB < 1_024 || memoryMiB > 32_768) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Sandbox memory allocation is invalid.",
      400,
    );
  }
  return {
    id,
    name,
    label: normalizeLabel(String(record.label ?? "")),
    workspaceFingerprint,
    createdAt,
    cpus,
    memoryMiB,
  };
}

function parseObservedSandboxes(output: string): ReadonlyMap<string, string> {
  if (output.trim().length === 0) {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new RuntimeError(
      "PROCESS_FAILED",
      "Docker Sandboxes returned invalid JSON.",
      502,
    );
  }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { sandboxes?: unknown }).sandboxes)
      ? (parsed as { sandboxes: unknown[] }).sandboxes
      : null;
  if (values === null) {
    throw new RuntimeError(
      "PROCESS_FAILED",
      "Docker Sandboxes returned an unsupported list schema.",
      502,
    );
  }
  const result = new Map<string, string>();
  for (const value of values) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    const name = [record.name, record.sandbox, record.Name].find(
      (candidate) => typeof candidate === "string",
    );
    if (typeof name !== "string") {
      continue;
    }
    const status = [record.status, record.state, record.Status].find(
      (candidate) => typeof candidate === "string",
    );
    result.set(
      name,
      typeof status === "string" ? status.slice(0, 64) : "unknown",
    );
  }
  return result;
}

function publicSummary(
  entry: SandboxRegistryEntry,
  status: string,
): SandboxSummary {
  return {
    id: entry.id,
    label: entry.label,
    provider: "docker-sbx",
    status,
    createdAt: entry.createdAt,
    cpus: entry.cpus,
    memoryMiB: entry.memoryMiB,
    workspaceFingerprint: entry.workspaceFingerprint,
    isolation: {
      mode: "clone",
      hostRepository: "read-only",
      hostWorkingTree: "unchanged",
      hostGitConfig: "sandbox-remote-managed",
      network: "deny-all",
    },
  };
}

export class SandboxManager {
  readonly #workspaceRoot: string;
  readonly #workspaceFingerprint: string;
  readonly #registryPath: string;
  readonly #storageRoot: string;
  readonly #executablePath: string;
  readonly #expectedVersion: string;
  readonly #expectedExecutableSha256: string;
  readonly #runner: SandboxProcessRunner;
  readonly #artifactCollector: SandboxArtifactCollector;
  #loaded = false;
  #entries = new Map<string, SandboxRegistryEntry>();
  readonly #activeExecCounts = new Map<string, number>();
  readonly #activeCollectionCounts = new Map<string, number>();
  readonly #removingIds = new Set<string>();
  #queue: Promise<void> = Promise.resolve();

  constructor(options: SandboxManagerOptions) {
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#workspaceFingerprint = createHash("sha256")
      .update(this.#workspaceRoot.toLocaleLowerCase("en-US"), "utf8")
      .digest("hex");
    this.#registryPath = resolve(options.registryPath);
    this.#storageRoot = resolve(
      options.storageRoot ?? dirname(this.#registryPath),
    );
    if (!isContainedPath(this.#storageRoot, this.#registryPath)) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Sandbox registry must remain inside its storage root.",
        400,
      );
    }
    if (isContainedPath(this.#workspaceRoot, this.#registryPath)) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Sandbox registry storage must remain outside the authorized workspace.",
        400,
      );
    }
    const localAppData = process.env.LOCALAPPDATA;
    this.#executablePath =
      options.executablePath === undefined
        ? localAppData === undefined
          ? resolve(process.cwd(), "__sovereign_sbx_unavailable__.exe")
          : join(localAppData, "DockerSandboxes", "bin", "sbx.exe")
        : resolve(options.executablePath);
    if (isContainedPath(this.#workspaceRoot, this.#executablePath)) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Docker Sandboxes executable must remain outside the authorized workspace.",
        400,
      );
    }
    this.#expectedVersion = options.expectedVersion ?? SBX_REVIEWED_VERSION;
    if (
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(this.#expectedVersion)
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Reviewed Docker Sandboxes version is invalid.",
        400,
      );
    }
    this.#expectedExecutableSha256 = (
      options.expectedExecutableSha256 ?? SBX_REVIEWED_WINDOWS_X64_SHA256
    ).toLocaleLowerCase("en-US");
    if (!/^[a-f0-9]{64}$/u.test(this.#expectedExecutableSha256)) {
      throw new RuntimeError(
        "INVALID_HASH",
        "Reviewed Docker Sandboxes executable SHA-256 is invalid.",
        400,
      );
    }
    this.#runner = options.runner ?? defaultSandboxProcessRunner;
    this.#artifactCollector = new SandboxArtifactCollector({
      workspaceRoot: this.#workspaceRoot,
      ...(options.gitRunner === undefined ? {} : { runner: options.gitRunner }),
    });
  }

  async capabilities(): Promise<SandboxCapabilities> {
    let available = false;
    let executableSha256: string | null = null;
    let version: string | null = null;
    try {
      const info = await lstat(this.#executablePath);
      available = true;
      if (info.isSymbolicLink() || !info.isFile()) {
        return this.#capabilityResult(
          true,
          false,
          false,
          false,
          null,
          null,
          "Docker Sandboxes executable is not a direct regular file.",
        );
      }
      const [canonicalWorkspace, canonicalExecutable] = await Promise.all([
        realpath(this.#workspaceRoot),
        realpath(this.#executablePath),
      ]);
      if (isContainedPath(canonicalWorkspace, canonicalExecutable)) {
        return this.#capabilityResult(
          true,
          false,
          false,
          false,
          null,
          null,
          "Docker Sandboxes executable resolves inside the authorized workspace.",
        );
      }
      executableSha256 = await sha256File(this.#executablePath, info.size);
      const versionResult = await this.#run(["version"], 15_000);
      const match = /sbx version:\s*v(\d+\.\d+\.\d+)/u.exec(
        `${versionResult.stdout}
${versionResult.stderr}`,
      );
      version = match?.[1] ?? null;
      const trusted =
        executableSha256 === this.#expectedExecutableSha256 &&
        version === this.#expectedVersion &&
        versionResult.exitCode === 0 &&
        !versionResult.outputTruncated &&
        !versionResult.timedOut;
      if (!trusted) {
        return this.#capabilityResult(
          true,
          false,
          false,
          false,
          version,
          executableSha256,
          "Docker Sandboxes executable version or SHA-256 does not match the reviewed build.",
        );
      }
      const list = await this.#run(["ls", "--json"], 20_000);
      if (list.exitCode === 0 && !list.outputTruncated && !list.timedOut) {
        try {
          parseObservedSandboxes(list.stdout);
        } catch (error) {
          return this.#capabilityResult(
            true,
            true,
            false,
            false,
            version,
            executableSha256,
            this.#redact(error),
          );
        }
        return this.#capabilityResult(
          true,
          true,
          true,
          true,
          version,
          executableSha256,
          null,
        );
      }
      const combined = `${list.stdout}
${list.stderr}`;
      if (/not authenticated|sign in with:\s*sbx login/iu.test(combined)) {
        return this.#capabilityResult(
          true,
          true,
          true,
          false,
          version,
          executableSha256,
          "Docker sign-in is required. Run sbx login locally.",
        );
      }
      return this.#capabilityResult(
        true,
        true,
        true,
        false,
        version,
        executableSha256,
        "Docker Sandboxes readiness probe failed.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.#capabilityResult(
          false,
          false,
          false,
          false,
          null,
          null,
          "Docker Sandboxes is not installed.",
        );
      }
      return this.#capabilityResult(
        available,
        false,
        false,
        false,
        version,
        executableSha256,
        this.#redact(error),
      );
    }
  }

  async list(): Promise<SandboxListResult> {
    await this.#ensureReady();
    const entries = await this.#serialized(async () => {
      await this.#load();
      return [...this.#entries.values()]
        .filter(
          (entry) => entry.workspaceFingerprint === this.#workspaceFingerprint,
        )
        .map((entry) => ({ ...entry }))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    });
    const observedResult = await this.#run(["ls", "--json"], 30_000);
    this.#assertSuccessful(observedResult, "list sandboxes");
    const observed = parseObservedSandboxes(observedResult.stdout);
    const sandboxes = entries.map((entry) =>
      publicSummary(entry, observed.get(entry.name) ?? "missing"),
    );
    return {
      schemaVersion: SANDBOX_LIST_SCHEMA_VERSION,
      count: sandboxes.length,
      sandboxes,
    };
  }

  create(input: SandboxCreateInput): Promise<SandboxSummary> {
    return this.#serialized(async () => {
      await this.#ensureReady();
      await this.#assertCloneableWorkspace();
      await this.#load();
      const ownEntries = [...this.#entries.values()].filter(
        (entry) => entry.workspaceFingerprint === this.#workspaceFingerprint,
      );
      if (ownEntries.length >= MAX_SANDBOXES_PER_WORKSPACE) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "Workspace sandbox limit has been reached.",
          409,
        );
      }
      const label = normalizeLabel(input.label);
      if (!Number.isInteger(input.cpus) || input.cpus < 1 || input.cpus > 32) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "Sandbox cpus must be from 1 through 32.",
          400,
        );
      }
      if (
        !Number.isInteger(input.memoryMiB) ||
        input.memoryMiB < 1_024 ||
        input.memoryMiB > 32_768
      ) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "Sandbox memoryMiB must be from 1024 through 32768.",
          400,
        );
      }
      const id = randomUUID();
      const name = `sovereign-${slugForLabel(label)}-${id.replaceAll("-", "").slice(0, 8)}`;
      const result = await this.#run(
        [
          "create",
          "--clone",
          "--name",
          name,
          "--cpus",
          String(input.cpus),
          "--memory",
          `${input.memoryMiB}m`,
          "--deny-network",
          "**",
          "shell",
          this.#workspaceRoot,
        ],
        300_000,
      );
      this.#assertSuccessful(result, "create sandbox");
      const entry: SandboxRegistryEntry = {
        id,
        name,
        label,
        workspaceFingerprint: this.#workspaceFingerprint,
        createdAt: new Date().toISOString(),
        cpus: input.cpus,
        memoryMiB: input.memoryMiB,
      };
      this.#entries.set(entry.id, entry);
      try {
        await this.#write();
      } catch (error) {
        await this.#run(["rm", "--force", name], 120_000).catch(
          () => undefined,
        );
        this.#entries.delete(entry.id);
        throw error;
      }
      return publicSummary(entry, "created");
    });
  }

  async exec(
    id: string,
    command: string,
    timeoutMs = 120_000,
  ): Promise<SandboxProcessResult> {
    await this.#ensureReady();
    const normalizedCommand = command.trim();
    if (
      normalizedCommand.length === 0 ||
      command.length > 32_768 ||
      command.includes("\0")
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Sandbox command is invalid.",
        400,
      );
    }
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 900_000
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Sandbox timeoutMs must be from 1000 through 900000.",
        400,
      );
    }
    const commandSha256 = createHash("sha256")
      .update(normalizedCommand, "utf8")
      .digest("hex");
    const entry = await this.#serialized(async () => {
      await this.#load();
      const owned = this.#requireOwned(id);
      this.#activeExecCounts.set(
        owned.id,
        (this.#activeExecCounts.get(owned.id) ?? 0) + 1,
      );
      return { ...owned };
    });
    try {
      const result = await this.#run(
        [
          "exec",
          entry.name,
          "bash",
          "-lc",
          `cd "$(git rev-parse --show-toplevel)" && ${normalizedCommand}`,
        ],
        timeoutMs,
      );
      if (result.timedOut) {
        throw new RuntimeError(
          "PROCESS_TIMEOUT",
          "Sandbox command timed out.",
          504,
          { durationMs: result.durationMs },
        );
      }
      return {
        ...result,
        commandLabel: `sbx exec ${entry.name} bash -lc <command:${commandSha256}>`,
      };
    } finally {
      await this.#serialized(async () => {
        const count = this.#activeExecCounts.get(entry.id) ?? 0;
        if (count <= 1) {
          this.#activeExecCounts.delete(entry.id);
        } else {
          this.#activeExecCounts.set(entry.id, count - 1);
        }
      });
    }
  }

  async collect(id: string): Promise<CollectedSandboxArtifacts> {
    await this.#ensureReady();
    await this.#assertCloneableWorkspace();
    const entry = await this.#serialized(async () => {
      await this.#load();
      const owned = this.#requireOwned(id);
      this.#activeCollectionCounts.set(
        owned.id,
        (this.#activeCollectionCounts.get(owned.id) ?? 0) + 1,
      );
      return { ...owned };
    });
    try {
      return await this.#artifactCollector.collect(entry.id, entry.name);
    } finally {
      await this.#serialized(async () => {
        const count = this.#activeCollectionCounts.get(entry.id) ?? 0;
        if (count <= 1) this.#activeCollectionCounts.delete(entry.id);
        else this.#activeCollectionCounts.set(entry.id, count - 1);
      });
    }
  }

  async stop(id: string): Promise<SandboxSummary> {
    await this.#ensureReady();
    const entry = await this.#serialized(async () => {
      await this.#load();
      const owned = this.#requireOwned(id);
      if ((this.#activeCollectionCounts.get(owned.id) ?? 0) > 0) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "Sandbox cannot be stopped while artifact collection is active.",
          409,
        );
      }
      return { ...owned };
    });
    const result = await this.#run(["stop", entry.name], 120_000);
    this.#assertSuccessful(result, "stop sandbox");
    return publicSummary(entry, "stopped");
  }

  async remove(
    id: string,
  ): Promise<{ readonly removed: true; readonly id: string }> {
    await this.#ensureReady();
    const entry = await this.#serialized(async () => {
      await this.#load();
      const owned = this.#requireOwned(id);
      if (
        (this.#activeExecCounts.get(owned.id) ?? 0) > 0 ||
        (this.#activeCollectionCounts.get(owned.id) ?? 0) > 0
      ) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "Sandbox cannot be removed while commands or artifact collection are active.",
          409,
        );
      }
      this.#removingIds.add(owned.id);
      return { ...owned };
    });
    try {
      const result = await this.#run(["rm", "--force", entry.name], 180_000);
      this.#assertSuccessful(result, "remove sandbox");
      await this.#serialized(async () => {
        this.#entries.delete(entry.id);
        try {
          await this.#write();
        } catch (error) {
          this.#entries.set(entry.id, entry);
          throw error;
        } finally {
          this.#removingIds.delete(entry.id);
        }
      });
      return { removed: true, id: entry.id };
    } catch (error) {
      await this.#serialized(async () => {
        this.#removingIds.delete(entry.id);
      });
      throw error;
    }
  }

  #redact(value: unknown): string {
    let message = safeText(value, 2_000);
    const replacements: readonly (readonly [string | undefined, string])[] = [
      [this.#workspaceRoot, "<workspace>"],
      [this.#registryPath, "<sandbox-registry>"],
      [this.#storageRoot, "<security-storage>"],
      [this.#executablePath, "<sbx-executable>"],
      [process.env.USERPROFILE, "<user-profile>"],
      [process.env.LOCALAPPDATA, "<local-app-data>"],
    ];
    for (const [candidate, replacement] of replacements) {
      if (candidate === undefined || candidate.length === 0) {
        continue;
      }
      message = message
        .replaceAll(candidate, replacement)
        .replaceAll(candidate.replaceAll("\\", "/"), replacement);
    }
    return message;
  }

  #capabilityResult(
    available: boolean,
    trusted: boolean,
    compatible: boolean,
    authenticated: boolean,
    version: string | null,
    executableSha256: string | null,
    reason: string | null,
  ): SandboxCapabilities {
    return {
      schemaVersion: SANDBOX_CAPABILITIES_SCHEMA_VERSION,
      provider: "docker-sbx",
      available,
      trusted,
      compatible,
      authenticated,
      executable: basename(this.#executablePath),
      version,
      expectedVersion: this.#expectedVersion,
      executableSha256,
      expectedExecutableSha256: this.#expectedExecutableSha256,
      loginRequired: available && trusted && compatible && !authenticated,
      reason,
      guarantees: {
        microVm: true,
        privateClone: true,
        hostRepositoryReadOnly: true,
        hostWorkingTree: "unchanged",
        hostGitConfig: "sandbox-remote-managed",
        network: "deny-all",
        hostShell: false,
        privilegedExec: false,
        hostPathCopy: false,
      },
    };
  }

  async #ensureReady(): Promise<void> {
    const capabilities = await this.capabilities();
    if (!capabilities.available) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        capabilities.reason ?? "Docker Sandboxes is unavailable.",
        503,
      );
    }
    if (!capabilities.trusted) {
      throw new RuntimeError(
        "POLICY_DENIED",
        capabilities.reason ?? "Docker Sandboxes is untrusted.",
        403,
      );
    }
    if (!capabilities.compatible) {
      throw new RuntimeError(
        "POLICY_DENIED",
        capabilities.reason ?? "Docker Sandboxes CLI is incompatible.",
        403,
      );
    }
    if (!capabilities.authenticated) {
      throw new RuntimeError(
        "AUTH_REQUIRED",
        capabilities.reason ?? "Docker sign-in is required.",
        401,
      );
    }
  }

  async #assertCloneableWorkspace(): Promise<void> {
    const rootInfo = await lstat(this.#workspaceRoot).catch(() => null);
    const gitInfo = await lstat(join(this.#workspaceRoot, ".git")).catch(
      () => null,
    );
    if (
      rootInfo === null ||
      !rootInfo.isDirectory() ||
      gitInfo === null ||
      !gitInfo.isDirectory()
    ) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Secure clone mode requires the main checkout of a Git repository; linked worktrees are rejected.",
        409,
      );
    }
    const [canonicalRoot, canonicalGit] = await Promise.all([
      realpath(this.#workspaceRoot),
      realpath(join(this.#workspaceRoot, ".git")),
    ]);
    const contained = relative(canonicalRoot, canonicalGit);
    if (
      contained.length === 0 ||
      contained === ".." ||
      contained.startsWith(`..${sep}`) ||
      isAbsolute(contained)
    ) {
      throw new RuntimeError(
        "PATH_ESCAPE",
        "Git metadata resolves outside the workspace.",
        400,
      );
    }
  }

  #requireOwned(id: string): SandboxRegistryEntry {
    const normalized = normalizeId(id);
    const entry = this.#entries.get(normalized);
    if (
      entry === undefined ||
      entry.workspaceFingerprint !== this.#workspaceFingerprint
    ) {
      throw new RuntimeError(
        "PATH_NOT_FOUND",
        "Managed sandbox was not found.",
        404,
      );
    }
    if (this.#removingIds.has(entry.id)) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Managed sandbox is being removed.",
        409,
      );
    }
    return entry;
  }

  #assertSuccessful(result: SandboxProcessResult, operation: string): void {
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
      const detail = this.#redact(
        result.stderr.trim().length > 0
          ? result.stderr.trim()
          : result.stdout.trim(),
      );
      throw new RuntimeError(
        result.timedOut ? "PROCESS_TIMEOUT" : "PROCESS_FAILED",
        `Could not ${operation}${detail.length === 0 ? "." : `: ${detail}`}`,
        result.timedOut ? 504 : 502,
      );
    }
  }

  #run(
    args: readonly string[],
    timeoutMs: number,
  ): Promise<SandboxProcessResult> {
    if (
      args.length === 0 ||
      args.length > 128 ||
      args.some(
        (argument) => argument.length > 32_768 || argument.includes("\0"),
      )
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Docker Sandboxes arguments are invalid.",
        400,
      );
    }
    return this.#runner(this.#executablePath, args, {
      cwd: this.#workspaceRoot,
      timeoutMs,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    }).catch((error: unknown) => {
      if (error instanceof RuntimeError) {
        throw new RuntimeError(error.code, this.#redact(error), error.status);
      }
      throw new RuntimeError(
        "PROCESS_FAILED",
        `Docker Sandboxes process failed: ${this.#redact(error)}`,
        502,
      );
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    let output!: T;
    const run = async (): Promise<void> => {
      output = await operation();
    };
    const queued = this.#queue.then(run, run);
    this.#queue = queued.catch(() => undefined);
    return queued.then(() => output);
  }

  async #canonicalRegistryPath(): Promise<string> {
    const parent = dirname(this.#registryPath);
    await Promise.all([
      mkdir(this.#storageRoot, { recursive: true }),
      mkdir(parent, { recursive: true }),
    ]);
    const [canonicalWorkspace, canonicalStorageRoot, canonicalParent] =
      await Promise.all([
        realpath(this.#workspaceRoot),
        realpath(this.#storageRoot),
        realpath(parent),
      ]);
    if (!isContainedPath(canonicalStorageRoot, canonicalParent)) {
      throw new RuntimeError(
        "PATH_ESCAPE",
        "Sandbox registry resolves outside its storage root.",
        400,
      );
    }
    if (isContainedPath(canonicalWorkspace, canonicalParent)) {
      throw new RuntimeError(
        "PATH_REJECTED",
        "Sandbox registry storage resolves inside the authorized workspace.",
        400,
      );
    }
    const canonicalPath = join(canonicalParent, basename(this.#registryPath));
    const registryInfo = await lstat(canonicalPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (
      registryInfo !== null &&
      (registryInfo.isSymbolicLink() || !registryInfo.isFile())
    ) {
      throw new RuntimeError(
        "PATH_SYMLINK",
        "Sandbox registry must be a direct regular file.",
        400,
      );
    }
    return canonicalPath;
  }

  async #load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    const canonicalPath = await this.#canonicalRegistryPath();
    let entries: SandboxRegistryEntry[] = [];
    try {
      const bytes = await readFile(canonicalPath);
      if (bytes.byteLength > MAX_REGISTRY_BYTES) {
        throw new RuntimeError(
          "FILE_TOO_LARGE",
          "Sandbox registry is too large.",
          413,
        );
      }
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        (parsed as { schemaVersion?: unknown }).schemaVersion !==
          SANDBOX_REGISTRY_SCHEMA_VERSION ||
        !Array.isArray((parsed as { entries?: unknown }).entries)
      ) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "Sandbox registry schema is invalid.",
          400,
        );
      }
      entries = (parsed as { entries: unknown[] }).entries.map(
        normalizeRegistryEntry,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id) || names.has(entry.name)) {
        throw new RuntimeError(
          "INVALID_INPUT",
          "Sandbox registry contains duplicates.",
          400,
        );
      }
      ids.add(entry.id);
      names.add(entry.name);
    }
    this.#entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.#loaded = true;
  }

  async #write(): Promise<void> {
    const canonicalPath = await this.#canonicalRegistryPath();
    const document: SandboxRegistryDocument = {
      schemaVersion: SANDBOX_REGISTRY_SCHEMA_VERSION,
      entries: [...this.#entries.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    };
    const content = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_REGISTRY_BYTES) {
      throw new RuntimeError(
        "FILE_TOO_LARGE",
        "Sandbox registry exceeds its limit.",
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
