import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  RuntimeError,
  canonicalJson,
  sha256,
  type AuditStore,
  type PublicRuntimeError,
  type RuntimePermissionProfile,
  type ToolManifest,
} from "@sovereign/runtime-core";
import {
  defineTool,
  objectSchema,
  type RuntimeToolDefinition,
  type ToolExecutionContext,
} from "@sovereign/toolkit";

import type { ToolPackStatus } from "./tool-pack-manager.js";

export const CAPABILITY_SEARCH_SCHEMA_VERSION =
  "scr.capabilities/search/v1" as const;
export const CAPABILITY_DESCRIPTION_SCHEMA_VERSION =
  "scr.capabilities/description/v1" as const;
export const CAPABILITY_EXECUTION_SCHEMA_VERSION =
  "scr.capabilities/execution/v1" as const;
export const CAPABILITY_SNAPSHOT_SCHEMA_VERSION =
  "scr.capabilities/snapshot/v1" as const;
export const CLIENT_CATALOG_STATUS_SCHEMA_VERSION =
  "scr.client-catalog-status/v1" as const;

const CAPABILITY_CURSOR_SCHEMA_VERSION = "scr.capability-cursor/v1" as const;
const STABLE_FACADE_NAMES = [
  "capabilities.search",
  "capabilities.describe",
  "capabilities.execute",
  "capabilities.snapshot",
  "client.catalog_status",
] as const;
const FACADE_EXECUTABLE_CATEGORIES = new Set([
  "system",
  "workspace",
  "files",
  "search",
  "git",
  "runs",
  "code",
]);
const FACADE_EXCLUDED_NAMES = new Set<string>(STABLE_FACADE_NAMES);

interface CapabilityCursorPayload {
  readonly schemaVersion: typeof CAPABILITY_CURSOR_SCHEMA_VERSION;
  readonly fingerprint: string;
  readonly offset: number;
}

interface CapabilityPackReference {
  readonly id: string;
  readonly version: string;
  readonly title: string;
}

export interface CapabilityEntry {
  readonly name: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly requiredCapabilities: readonly string[];
  readonly sideEffect: "read" | "write" | "process";
  readonly destructive: boolean;
  readonly permissionLevel: "observe" | "workspace" | "consequential";
  readonly approvalMode: "none" | "session" | "single-use";
  readonly pack: CapabilityPackReference | null;
  readonly facadeExecutable: boolean;
}

export interface CapabilityDescription extends CapabilityEntry {
  readonly schemaVersion: typeof CAPABILITY_DESCRIPTION_SCHEMA_VERSION;
  readonly manifestDigest: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly runtimeAuthorization: CapabilityAuthorization | null;
}

export interface CapabilityAuthorization {
  readonly workspaceId: string;
  readonly permissionProfile: RuntimePermissionProfile;
  readonly profileAllowsTool: boolean;
  readonly policyDenial: PublicRuntimeError | null;
  readonly localApproval: "blocked" | "not-required" | "broker-required" | "unavailable";
  readonly clientApproval: "independent";
  readonly taskScope: "not-inferred";
}

export interface CapabilityDirectoryBinding {
  readonly definitions: () => readonly RuntimeToolDefinition[];
  readonly manifest: () => ToolManifest;
  readonly toolPacks: () => ToolPackStatus;
  readonly describeAuthorization: (
    context: ToolExecutionContext,
    definition: RuntimeToolDefinition,
  ) => CapabilityAuthorization | null;
  readonly invoke: (
    context: ToolExecutionContext,
    toolName: string,
    input: unknown,
  ) => Promise<unknown>;
}

export interface CapabilityDirectoryOptions {
  readonly audit: AuditStore;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\0\r\n]+/gu, " ").slice(0, 1_000);
}

function runtimeErrorCode(error: unknown): string {
  return error instanceof RuntimeError ? error.code : "INTERNAL_ERROR";
}

function encodeCursor(payload: CapabilityCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  fingerprint: string,
): CapabilityCursorPayload {
  if (cursor === undefined) {
    return {
      schemaVersion: CAPABILITY_CURSOR_SCHEMA_VERSION,
      fingerprint,
      offset: 0,
    };
  }
  if (
    cursor.length === 0 ||
    cursor.length > 2_048 ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Capability cursor is malformed.",
      400,
    );
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("invalid cursor payload");
    }
    const value = parsed as Partial<CapabilityCursorPayload>;
    if (
      value.schemaVersion !== CAPABILITY_CURSOR_SCHEMA_VERSION ||
      value.fingerprint !== fingerprint ||
      !Number.isInteger(value.offset) ||
      (value.offset ?? -1) < 0
    ) {
      throw new Error("invalid cursor fields");
    }
    return value as CapabilityCursorPayload;
  } catch {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Capability cursor is stale or does not match the current search.",
      400,
    );
  }
}

function normalizedQuery(value: string | undefined): string {
  const query = value?.trim().toLocaleLowerCase("en-US") ?? "";
  if (query.length > 500) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Capability search query exceeds 500 characters.",
      400,
    );
  }
  return query;
}

function facadeExecutable(definition: RuntimeToolDefinition): boolean {
  const spec = definition.spec;
  return (
    spec.permissionLevel === "observe" &&
    spec.destructive === false &&
    FACADE_EXECUTABLE_CATEGORIES.has(spec.category) &&
    !FACADE_EXCLUDED_NAMES.has(spec.name) &&
    !spec.name.startsWith("tasks.") &&
    !spec.name.startsWith("browser.") &&
    !spec.name.startsWith("computer.") &&
    !spec.name.startsWith("terminal.") &&
    !spec.name.startsWith("python.") &&
    !spec.name.startsWith("workflow.")
  );
}

export class CapabilityDirectory {
  readonly #audit: AuditStore;
  #binding: CapabilityDirectoryBinding | null = null;

  constructor(options: CapabilityDirectoryOptions) {
    this.#audit = options.audit;
  }

  bind(binding: CapabilityDirectoryBinding): void {
    if (this.#binding !== null) {
      throw new RuntimeError(
        "INTERNAL_ERROR",
        "Capability directory was already bound.",
        500,
      );
    }
    this.#binding = binding;
  }

  search(input: {
    readonly query?: string | undefined;
    readonly categories?: readonly string[] | undefined;
    readonly packId?: string | undefined;
    readonly permissionLevel?:
      "observe" | "workspace" | "consequential" | undefined;
    readonly executableOnly?: boolean | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): {
    readonly schemaVersion: typeof CAPABILITY_SEARCH_SCHEMA_VERSION;
    readonly manifestDigest: string;
    readonly query: string | null;
    readonly totalMatched: number;
    readonly returned: number;
    readonly entries: readonly CapabilityEntry[];
    readonly nextCursor: string | null;
  } {
    const binding = this.#requireBinding();
    const query = normalizedQuery(input.query);
    const categories = [...new Set(input.categories ?? [])]
      .map((category) => category.trim().toLocaleLowerCase("en-US"))
      .filter((category) => category.length > 0)
      .sort();
    const packId = input.packId?.trim() ?? "";
    const permissionLevel = input.permissionLevel ?? null;
    const executableOnly = input.executableOnly ?? false;
    const limit = input.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Capability search limit must be from 1 through 100.",
        400,
      );
    }
    const manifest = binding.manifest();
    const fingerprint = sha256(
      canonicalJson({
        manifestDigest: manifest.digest,
        query,
        categories,
        packId,
        permissionLevel,
        executableOnly,
      }),
    );
    const cursor = decodeCursor(input.cursor, fingerprint);
    const entries = binding
      .definitions()
      .map((definition) => this.#entry(definition))
      .filter((entry) => {
        if (
          categories.length > 0 &&
          !categories.includes(entry.category.toLocaleLowerCase("en-US"))
        ) {
          return false;
        }
        if (packId.length > 0 && entry.pack?.id !== packId) {
          return false;
        }
        if (
          permissionLevel !== null &&
          entry.permissionLevel !== permissionLevel
        ) {
          return false;
        }
        if (executableOnly && !entry.facadeExecutable) {
          return false;
        }
        if (query.length === 0) {
          return true;
        }
        const haystack = [
          entry.name,
          entry.title,
          entry.description,
          entry.category,
          entry.pack?.id ?? "core",
          ...entry.requiredCapabilities,
        ]
          .join("\n")
          .toLocaleLowerCase("en-US");
        return haystack.includes(query);
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    if (cursor.offset > entries.length) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Capability cursor points past the current result set.",
        400,
      );
    }
    const page = entries.slice(cursor.offset, cursor.offset + limit);
    const nextOffset = cursor.offset + page.length;
    return {
      schemaVersion: CAPABILITY_SEARCH_SCHEMA_VERSION,
      manifestDigest: manifest.digest,
      query: query.length === 0 ? null : (input.query?.trim() ?? null),
      totalMatched: entries.length,
      returned: page.length,
      entries: page,
      nextCursor:
        nextOffset < entries.length
          ? encodeCursor({
              schemaVersion: CAPABILITY_CURSOR_SCHEMA_VERSION,
              fingerprint,
              offset: nextOffset,
            })
          : null,
    };
  }

  describe(
    toolName: string,
    context?: ToolExecutionContext,
  ): CapabilityDescription {
    const binding = this.#requireBinding();
    const definition = binding
      .definitions()
      .find((candidate) => candidate.spec.name === toolName);
    if (definition === undefined) {
      throw new RuntimeError(
        "TOOL_NOT_FOUND",
        `Unknown active capability: ${toolName}`,
        404,
      );
    }
    return {
      schemaVersion: CAPABILITY_DESCRIPTION_SCHEMA_VERSION,
      manifestDigest: binding.manifest().digest,
      ...this.#entry(definition),
      inputSchema: definition.spec.inputSchema,
      runtimeAuthorization:
        context === undefined
          ? null
          : binding.describeAuthorization(context, definition),
    };
  }

  snapshot(): {
    readonly schemaVersion: typeof CAPABILITY_SNAPSHOT_SCHEMA_VERSION;
    readonly manifest: {
      readonly digest: string;
      readonly runtimeVersion: string;
      readonly toolCount: number;
    };
    readonly stableFacadeNames: readonly string[];
    readonly categoryCounts: Readonly<Record<string, number>>;
    readonly facadeExecutableCount: number;
    readonly toolPacks: ToolPackStatus;
  } {
    const binding = this.#requireBinding();
    const manifest = binding.manifest();
    const entries = binding
      .definitions()
      .map((definition) => this.#entry(definition));
    const categoryCounts: Record<string, number> = {};
    for (const entry of entries) {
      categoryCounts[entry.category] =
        (categoryCounts[entry.category] ?? 0) + 1;
    }
    return {
      schemaVersion: CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
      manifest: {
        digest: manifest.digest,
        runtimeVersion: manifest.runtimeVersion,
        toolCount: manifest.tools.length,
      },
      stableFacadeNames: [...STABLE_FACADE_NAMES],
      categoryCounts,
      facadeExecutableCount: entries.filter((entry) => entry.facadeExecutable)
        .length,
      toolPacks: binding.toolPacks(),
    };
  }

  catalogStatus(input: {
    readonly clientManifestDigest?: string | undefined;
    readonly clientToolCount?: number | undefined;
    readonly clientPackGeneration?: number | undefined;
  }): {
    readonly schemaVersion: typeof CLIENT_CATALOG_STATUS_SCHEMA_VERSION;
    readonly runtime: {
      readonly manifestDigest: string;
      readonly toolCount: number;
      readonly packGeneration: number;
    };
    readonly client: {
      readonly manifestDigest: string | null;
      readonly toolCount: number | null;
      readonly packGeneration: number | null;
    };
    readonly comparable: boolean;
    readonly inSync: boolean | null;
    readonly mismatches: readonly string[];
    readonly recommendedAction:
      "provide-client-snapshot" | "none" | "refresh-actions-or-relist";
  } {
    const binding = this.#requireBinding();
    const manifest = binding.manifest();
    const packs = binding.toolPacks();
    const comparable =
      input.clientManifestDigest !== undefined ||
      input.clientToolCount !== undefined ||
      input.clientPackGeneration !== undefined;
    const mismatches: string[] = [];
    if (
      input.clientManifestDigest !== undefined &&
      input.clientManifestDigest !== manifest.digest
    ) {
      mismatches.push("manifestDigest");
    }
    if (
      input.clientToolCount !== undefined &&
      input.clientToolCount !== manifest.tools.length
    ) {
      mismatches.push("toolCount");
    }
    if (
      input.clientPackGeneration !== undefined &&
      input.clientPackGeneration !== packs.generation
    ) {
      mismatches.push("packGeneration");
    }
    const inSync = comparable ? mismatches.length === 0 : null;
    return {
      schemaVersion: CLIENT_CATALOG_STATUS_SCHEMA_VERSION,
      runtime: {
        manifestDigest: manifest.digest,
        toolCount: manifest.tools.length,
        packGeneration: packs.generation,
      },
      client: {
        manifestDigest: input.clientManifestDigest ?? null,
        toolCount: input.clientToolCount ?? null,
        packGeneration: input.clientPackGeneration ?? null,
      },
      comparable,
      inSync,
      mismatches,
      recommendedAction: !comparable
        ? "provide-client-snapshot"
        : mismatches.length === 0
          ? "none"
          : "refresh-actions-or-relist",
    };
  }

  async execute(
    context: ToolExecutionContext,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<{
    readonly schemaVersion: typeof CAPABILITY_EXECUTION_SCHEMA_VERSION;
    readonly targetToolName: string;
    readonly manifestDigest: string;
    readonly result: unknown;
  }> {
    const binding = this.#requireBinding();
    const manifestDigest = binding.manifest().digest;
    const occurredAt = new Date().toISOString();
    const serializedInput = canonicalJson(input);
    const details = {
      targetToolName: toolName,
      inputBytes: Buffer.byteLength(serializedInput, "utf8"),
      inputSha256: sha256(serializedInput),
      manifestDigest,
    };
    try {
      const definition = binding
        .definitions()
        .find((candidate) => candidate.spec.name === toolName);
      if (definition === undefined) {
        throw new RuntimeError(
          "TOOL_NOT_FOUND",
          `Unknown active capability: ${toolName}`,
          404,
        );
      }
      if (!facadeExecutable(definition)) {
        throw new RuntimeError(
          "POLICY_DENIED",
          `Capability ${toolName} is not executable through the stable read-only facade. Use its dedicated Action.`,
          403,
          {
            toolName,
            category: definition.spec.category,
            permissionLevel: definition.spec.permissionLevel,
            destructive: definition.spec.destructive,
          },
        );
      }
      const result = await binding.invoke(context, toolName, input);
      this.#audit.append({
        id: randomUUID(),
        occurredAt,
        principalId: context.principal.id,
        toolName: "capabilities.execute",
        operation: "capability_dispatch",
        outcome: "succeeded",
        details,
      });
      return {
        schemaVersion: CAPABILITY_EXECUTION_SCHEMA_VERSION,
        targetToolName: toolName,
        manifestDigest,
        result,
      };
    } catch (error) {
      const errorMessage = boundedMessage(error);
      this.#audit.append({
        id: randomUUID(),
        occurredAt,
        principalId: context.principal.id,
        toolName: "capabilities.execute",
        operation: "capability_dispatch",
        outcome:
          error instanceof RuntimeError && error.code === "POLICY_DENIED"
            ? "denied"
            : "failed",
        errorCode: runtimeErrorCode(error),
        details: {
          ...details,
          errorMessageBytes: Buffer.byteLength(errorMessage, "utf8"),
          errorMessageSha256: sha256(errorMessage),
        },
      });
      throw error;
    }
  }

  #entry(definition: RuntimeToolDefinition): CapabilityEntry {
    const spec = definition.spec;
    const pack = this.#packFor(spec.name);
    return {
      name: spec.name,
      version: spec.version,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      requiredCapabilities: [...spec.requiredCapabilities],
      sideEffect: spec.sideEffect,
      destructive: spec.destructive,
      permissionLevel: spec.permissionLevel,
      approvalMode: spec.approvalMode,
      pack,
      facadeExecutable: facadeExecutable(definition),
    };
  }

  #packFor(toolName: string): CapabilityPackReference | null {
    const status = this.#requireBinding().toolPacks();
    const pack = status.available.find((candidate) =>
      candidate.toolNames.includes(toolName),
    );
    return pack === undefined
      ? null
      : {
          id: pack.id,
          version: pack.version,
          title: pack.title,
        };
  }

  #requireBinding(): CapabilityDirectoryBinding {
    if (this.#binding === null) {
      throw new RuntimeError(
        "INTERNAL_ERROR",
        "Capability directory is still initializing.",
        503,
      );
    }
    return this.#binding;
  }
}

export function createCapabilityDirectoryTools(
  directory: CapabilityDirectory,
): readonly RuntimeToolDefinition[] {
  return [
    defineTool(
      {
        name: "capabilities.search",
        version: "1.0.0",
        title: "Search capabilities",
        description:
          "Search the active runtime capability directory without changing the public Action schema for every low-frequency read tool.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          query: { type: "string", maxLength: 500 },
          categories: {
            type: "array",
            maxItems: 20,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          packId: { type: "string", minLength: 1, maxLength: 64 },
          permissionLevel: {
            type: "string",
            enum: ["observe", "workspace", "consequential"],
          },
          executableOnly: { type: "boolean", default: false },
          cursor: { type: "string", minLength: 1, maxLength: 2_048 },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 25,
          },
        }),
      },
      {
        query: z.string().max(500).optional(),
        categories: z.array(z.string().min(1).max(64)).max(20).optional(),
        packId: z.string().min(1).max(64).optional(),
        permissionLevel: z
          .enum(["observe", "workspace", "consequential"])
          .optional(),
        executableOnly: z.boolean().optional(),
        cursor: z.string().min(1).max(2_048).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      (_context, input) => directory.search(input),
    ),
    defineTool(
      {
        name: "capabilities.describe",
        version: "1.1.0",
        title: "Describe capability",
        description:
          "Return the active tool schema, current connection's Sovereign authorization and remaining local approval, pack ownership, and facade eligibility. Runtime access does not infer user task scope or satisfy independent client approval.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          toolName: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { toolName: z.string().min(1).max(128) },
      (context, input) => directory.describe(input.toolName, context),
    ),
    defineTool(
      {
        name: "capabilities.execute",
        version: "1.0.0",
        title: "Execute read-only capability",
        description:
          "Execute an active reviewed L1 capability through a stable facade. Mutations, task messaging, Terminal, browser, desktop control, Python, and workflows require dedicated Actions.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          toolName: { type: "string", minLength: 1, maxLength: 128 },
          input: { type: "object", additionalProperties: true },
        }),
      },
      {
        toolName: z.string().min(1).max(128),
        input: z.record(z.string(), z.unknown()),
      },
      (context, input) =>
        directory.execute(context, input.toolName, input.input),
    ),
    defineTool(
      {
        name: "capabilities.snapshot",
        version: "1.0.0",
        title: "Capability catalog snapshot",
        description:
          "Return the live manifest digest, tool count, pack generation, category counts, and stable facade names.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({}, []),
      },
      {},
      () => directory.snapshot(),
    ),
    defineTool(
      {
        name: "client.catalog_status",
        version: "1.0.0",
        title: "Compare client catalog",
        description:
          "Compare a client-provided action snapshot with the live runtime manifest without claiming to inspect an opaque ChatGPT approval cache.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          clientManifestDigest: {
            type: "string",
            minLength: 64,
            maxLength: 64,
            pattern: "^[a-f0-9]{64}$",
          },
          clientToolCount: {
            type: "integer",
            minimum: 0,
            maximum: 10_000,
          },
          clientPackGeneration: {
            type: "integer",
            minimum: 0,
            maximum: 1_000_000,
          },
        }),
      },
      {
        clientManifestDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
        clientToolCount: z.number().int().min(0).max(10_000).optional(),
        clientPackGeneration: z.number().int().min(0).max(1_000_000).optional(),
      },
      (_context, input) => directory.catalogStatus(input),
    ),
  ];
}
