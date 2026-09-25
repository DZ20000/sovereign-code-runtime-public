import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import type { AuditStore } from "@sovereign/runtime-core";
import type {
  RuntimeToolDefinition,
  RuntimeToolPack,
  ToolCatalog,
} from "@sovereign/toolkit";

export const TOOL_PACK_CONFIG_SCHEMA_VERSION = "scr.tool-packs/v1" as const;
export const TOOL_PACK_STATUS_SCHEMA_VERSION =
  "scr.tool-packs/status/v1" as const;

const MAX_CONFIG_BYTES = 64 * 1_024;
const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_POLL_MS = 2_000;
const toolPackId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const toolPackConfig = z
  .object({
    schemaVersion: z.literal(TOOL_PACK_CONFIG_SCHEMA_VERSION),
    enabled: z
      .array(toolPackId)
      .max(32)
      .refine(
        (values) => new Set(values).size === values.length,
        "Enabled tool-pack ids must be unique.",
      ),
  })
  .strict();

type ToolPackConfig = z.infer<typeof toolPackConfig>;

export interface ToolPackStatusEntry {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly toolNames: readonly string[];
}

export interface ToolPackStatus {
  readonly schemaVersion: typeof TOOL_PACK_STATUS_SCHEMA_VERSION;
  readonly configFile: string;
  readonly generation: number;
  readonly enabled: readonly string[];
  readonly available: readonly ToolPackStatusEntry[];
  readonly manifestDigest: string;
  readonly toolCount: number;
  readonly lastReloadAt: string | null;
  readonly lastError: string | null;
}

export interface ToolPackManagerOptions {
  readonly configPath: string;
  readonly baseDefinitions: readonly RuntimeToolDefinition[];
  readonly packs: readonly RuntimeToolPack[];
  readonly catalogs: readonly ToolCatalog[];
  readonly audit: AuditStore;
  readonly principalId?: string;
  readonly debounceMs?: number;
  readonly pollMs?: number;
  readonly watch?: boolean;
  readonly onChanged?: (status: ToolPackStatus) => void;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function messageFrom(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 499)}…`;
}

async function readBoundedConfig(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) {
      throw new Error(
        `Tool-pack configuration exceeds ${MAX_CONFIG_BYTES} bytes.`,
      );
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await handle.close();
  }
}

async function writeConfigAtomically(
  path: string,
  config: ToolPackConfig,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function validateDefinitionNames(
  definitions: readonly RuntimeToolDefinition[],
): void {
  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.spec.name)) {
      throw new Error(`Duplicate tool definition: ${definition.spec.name}`);
    }
    names.add(definition.spec.name);
  }
}

export class ToolPackManager {
  readonly #configPath: string;
  readonly #baseDefinitions: readonly RuntimeToolDefinition[];
  readonly #packs: ReadonlyMap<string, RuntimeToolPack>;
  readonly #catalogs: readonly ToolCatalog[];
  readonly #audit: AuditStore;
  readonly #principalId: string;
  readonly #debounceMs: number;
  readonly #pollMs: number;
  readonly #watchEnabled: boolean;
  readonly #onChanged: ((status: ToolPackStatus) => void) | undefined;
  #watcher: FSWatcher | null = null;
  #debounceTimer: NodeJS.Timeout | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #reloadQueue: Promise<void> = Promise.resolve();
  #lastAttemptDigest: string | null = null;
  #lastReadErrorFingerprint: string | null = null;
  #enabled: readonly string[] = [];
  #generation = 0;
  #lastReloadAt: string | null = null;
  #lastError: string | null = null;
  #closed = false;

  constructor(options: ToolPackManagerOptions) {
    if (options.catalogs.length === 0) {
      throw new Error("Tool-pack manager requires at least one catalog.");
    }
    this.#configPath = resolve(options.configPath);
    this.#baseDefinitions = [...options.baseDefinitions];
    this.#catalogs = [...options.catalogs];
    this.#audit = options.audit;
    this.#principalId = options.principalId ?? "runtime-host";
    this.#debounceMs = Math.max(
      25,
      Math.min(options.debounceMs ?? DEFAULT_DEBOUNCE_MS, 5_000),
    );
    this.#pollMs = Math.max(
      250,
      Math.min(options.pollMs ?? DEFAULT_POLL_MS, 60_000),
    );
    this.#watchEnabled = options.watch ?? true;
    this.#onChanged = options.onChanged;

    const initialManifestDigest = this.#catalogs[0]!.manifest.digest;
    const initialRuntimeVersion = this.#catalogs[0]!.manifest.runtimeVersion;
    if (
      this.#catalogs.some(
        (catalog) =>
          catalog.manifest.digest !== initialManifestDigest ||
          catalog.manifest.runtimeVersion !== initialRuntimeVersion,
      )
    ) {
      throw new Error(
        "Tool-pack catalogs must begin with the same manifest generation.",
      );
    }

    const packs = new Map<string, RuntimeToolPack>();
    for (const pack of options.packs) {
      toolPackId.parse(pack.id);
      if (packs.has(pack.id)) {
        throw new Error(`Duplicate tool-pack id: ${pack.id}`);
      }
      validateDefinitionNames(pack.definitions);
      packs.set(pack.id, pack);
    }
    this.#packs = packs;
    validateDefinitionNames([
      ...this.#baseDefinitions,
      ...[...packs.values()].flatMap((pack) => pack.definitions),
    ]);
  }

  get configPath(): string {
    return this.#configPath;
  }

  status(): ToolPackStatus {
    const manifest = this.#catalogs[0]!.manifest;
    const enabled = new Set(this.#enabled);
    return {
      schemaVersion: TOOL_PACK_STATUS_SCHEMA_VERSION,
      configFile: basename(this.#configPath),
      generation: this.#generation,
      enabled: [...this.#enabled],
      available: [...this.#packs.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((pack) => ({
          id: pack.id,
          version: pack.version,
          title: pack.title,
          description: pack.description,
          enabled: enabled.has(pack.id),
          toolNames: pack.definitions
            .map((definition) => definition.spec.name)
            .sort(),
        })),
      manifestDigest: manifest.digest,
      toolCount: manifest.tools.length,
      lastReloadAt: this.#lastReloadAt,
      lastError: this.#lastError,
    };
  }

  async start(): Promise<ToolPackStatus> {
    if (this.#closed) {
      throw new Error("Tool-pack manager is closed.");
    }
    await this.#ensureConfig();
    await this.reload();
    if (this.#watchEnabled) {
      this.#startWatching();
    }
    return this.status();
  }

  reload(principalId = this.#principalId): Promise<ToolPackStatus> {
    let status: ToolPackStatus = this.status();
    const operation = async (): Promise<void> => {
      if (this.#closed) {
        throw new Error("Tool-pack manager is closed.");
      }
      status = await this.#reloadNow(principalId);
    };
    const result = this.#reloadQueue.then(operation, operation);
    this.#reloadQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.then(() => status);
  }

  configure(
    enabled: readonly string[],
    principalId = this.#principalId,
  ): Promise<ToolPackStatus> {
    let status: ToolPackStatus = this.status();
    const operation = async (): Promise<void> => {
      if (this.#closed) {
        throw new Error("Tool-pack manager is closed.");
      }
      const config = this.#validateConfig({
        schemaVersion: TOOL_PACK_CONFIG_SCHEMA_VERSION,
        enabled: [...enabled],
      });
      await writeConfigAtomically(this.#configPath, config);
      this.#lastAttemptDigest = null;
      status = await this.#reloadNow(principalId);
      if (status.lastError !== null) {
        throw new Error(status.lastError);
      }
    };
    const result = this.#reloadQueue.then(operation, operation);
    this.#reloadQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.then(() => status);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#watcher?.close();
    this.#watcher = null;
    await this.#reloadQueue;
  }

  #validateConfig(value: unknown): ToolPackConfig {
    const parsed = toolPackConfig.parse(value);
    const enabled = [...parsed.enabled].sort();
    const unknown = enabled.filter((id) => !this.#packs.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown tool-pack id: ${unknown.join(", ")}`);
    }
    return {
      schemaVersion: TOOL_PACK_CONFIG_SCHEMA_VERSION,
      enabled,
    };
  }

  async #ensureConfig(): Promise<void> {
    await mkdir(dirname(this.#configPath), { recursive: true });
    const config: ToolPackConfig = {
      schemaVersion: TOOL_PACK_CONFIG_SCHEMA_VERSION,
      enabled: [...this.#packs.values()]
        .filter((pack) => pack.enabledByDefault)
        .map((pack) => pack.id)
        .sort(),
    };
    try {
      await writeFile(
        this.#configPath,
        `${JSON.stringify(config, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  async #reloadNow(principalId: string): Promise<ToolPackStatus> {
    const occurredAt = new Date().toISOString();
    let readSucceeded = false;
    try {
      const content = await readBoundedConfig(this.#configPath);
      readSucceeded = true;
      const recoveringFromReadError = this.#lastReadErrorFingerprint !== null;
      this.#lastReadErrorFingerprint = null;
      const digest = sha256(content);
      if (digest === this.#lastAttemptDigest && !recoveringFromReadError) {
        return this.status();
      }
      this.#lastAttemptDigest = digest;
      const parsed = this.#validateConfig(JSON.parse(content) as unknown);
      const definitions = [
        ...this.#baseDefinitions,
        ...parsed.enabled.flatMap((id) => this.#packs.get(id)!.definitions),
      ];
      validateDefinitionNames(definitions);

      const replacements = this.#catalogs.map((catalog) =>
        catalog.replaceDefinitions(definitions),
      );
      const manifestDigest = replacements[0]!.manifest.digest;
      if (
        replacements.some(
          (replacement) => replacement.manifest.digest !== manifestDigest,
        )
      ) {
        throw new Error("Tool catalogs diverged during the atomic reload.");
      }
      const changed = replacements.some((replacement) => replacement.changed);
      this.#enabled = [...parsed.enabled];
      this.#lastReloadAt = occurredAt;
      this.#lastError = null;
      if (changed) {
        this.#generation += 1;
        const primary = replacements[0]!;
        this.#audit.append({
          id: randomUUID(),
          occurredAt,
          principalId,
          toolName: "system.tool_packs",
          operation: "tool_pack_reload",
          outcome: "succeeded",
          details: {
            configFile: basename(this.#configPath),
            generation: this.#generation,
            enabled: [...this.#enabled],
            added: primary.added,
            removed: primary.removed,
            updated: primary.updated,
            manifestDigest,
          },
        });
      }
      this.#publishStatus();
      return this.status();
    } catch (error) {
      const sanitizedError = messageFrom(error).replaceAll(
        this.#configPath,
        basename(this.#configPath),
      );
      if (!readSucceeded) {
        const fingerprint = sha256(sanitizedError);
        if (fingerprint === this.#lastReadErrorFingerprint) {
          return this.status();
        }
        this.#lastReadErrorFingerprint = fingerprint;
      }
      this.#lastReloadAt = occurredAt;
      this.#lastError = sanitizedError;
      this.#audit.append({
        id: randomUUID(),
        occurredAt,
        principalId,
        toolName: "system.tool_packs",
        operation: "tool_pack_reload",
        outcome: "failed",
        errorCode: "INVALID_INPUT",
        details: {
          configFile: basename(this.#configPath),
          error: this.#lastError,
        },
      });
      this.#publishStatus();
      return this.status();
    }
  }

  #publishStatus(): void {
    try {
      this.#onChanged?.(this.status());
    } catch {
      // A desktop-state listener must not change an already validated catalog outcome.
    }
  }

  #startWatching(): void {
    if (this.#watcher !== null || this.#closed) {
      return;
    }
    const target = basename(this.#configPath).toLocaleLowerCase("en-US");
    this.#watcher = watch(
      dirname(this.#configPath),
      { persistent: false },
      (_eventType, filename) => {
        if (
          filename === null ||
          filename.toString().toLocaleLowerCase("en-US") === target
        ) {
          this.#scheduleReload();
        }
      },
    );
    this.#watcher.on("error", (error) => {
      this.#lastError = `Tool-pack watcher failed: ${messageFrom(error)}`;
      this.#publishStatus();
    });
    this.#pollTimer = setInterval(() => {
      void this.reload().catch(() => undefined);
    }, this.#pollMs);
    this.#pollTimer.unref();
  }

  #scheduleReload(): void {
    if (this.#closed) {
      return;
    }
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
    }
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.reload().catch(() => undefined);
    }, this.#debounceMs);
    this.#debounceTimer.unref();
  }
}
