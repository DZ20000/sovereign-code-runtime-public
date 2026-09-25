import type {
  ToolExecutionContext,
  ToolExecutionActivityEvent,
  ToolExecutionActivityHook,
} from "./tool-execution-context.js";
export type {
  ToolExecutionContext,
  ToolExecutionActivityPhase,
  ToolExecutionActivityOutcome,
  ToolExecutionActivityEvent,
  ToolExecutionActivityHook,
} from "./tool-execution-context.js";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  type Principal,
  PolicyEngine,
  RuntimeError,
  type ToolManifest,
  type ToolSpec,
  buildToolManifest,
  canonicalJson,
} from "@sovereign/runtime-core";
import { WindowsAdapter } from "@sovereign/windows-adapter";
import { defineTool, objectSchema, type RuntimeToolDefinition } from "./tool-definition.js";
export { defineTool, objectSchema, type RuntimeToolDefinition } from "./tool-definition.js";
import {
  requireSuccessfulTerminalExecution,
  terminalEvidencePersistenceError,
  toolExecutionReceiptId,
} from "./terminal-execution-result.js";

export interface ToolAuthorizationRequest {
  readonly principal: Principal;
  readonly spec: ToolSpec;
  readonly input: Readonly<Record<string, unknown>>;
}

export type ToolAuthorizationHook = (
  request: ToolAuthorizationRequest,
) => Promise<void> | void;

export type ToolRejectionStage = "lookup" | "schema" | "policy" | "authorization";

export interface ToolRejectionRequest {
  readonly principal: Principal;
  readonly toolName: string;
  readonly spec?: ToolSpec;
  readonly stage: ToolRejectionStage;
  readonly error: RuntimeError;
  readonly input?: Readonly<Record<string, unknown>>;
}

export type ToolRejectionHook = (
  request: ToolRejectionRequest,
) => Promise<void> | void;

export interface ToolCatalogChange {
  readonly previousManifest: ToolManifest;
  readonly manifest: ToolManifest;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly updated: readonly string[];
}

export type ToolCatalogChangeListener = (change: ToolCatalogChange) => void;

export interface ToolCatalogReplacement {
  readonly changed: boolean;
  readonly manifest: ToolManifest;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly updated: readonly string[];
}

function prepareToolDefinitions(
  definitions: readonly RuntimeToolDefinition[],
): {
  readonly definitions: readonly RuntimeToolDefinition[];
  readonly byName: ReadonlyMap<string, RuntimeToolDefinition>;
} {
  const byName = new Map<string, RuntimeToolDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.spec.name)) {
      throw new RuntimeError(
        "INTERNAL_ERROR",
        `Duplicate tool definition: ${definition.spec.name}`,
        500,
      );
    }
    byName.set(definition.spec.name, definition);
  }
  return {
    definitions: [...definitions],
    byName,
  };
}

export class ToolCatalog {
  #definitions: readonly RuntimeToolDefinition[];
  #byName: ReadonlyMap<string, RuntimeToolDefinition>;
  readonly #policy: PolicyEngine;
  readonly #runtimeVersion: string;
  readonly #authorize: ToolAuthorizationHook | undefined;
  readonly #onRejected: ToolRejectionHook | undefined;
  readonly #onExecutionActivity: ToolExecutionActivityHook | undefined;
  readonly #changeListeners = new Set<ToolCatalogChangeListener>();
  #manifest: ToolManifest;

  constructor(
    definitions: readonly RuntimeToolDefinition[],
    policy: PolicyEngine,
    runtimeVersion: string,
    authorize?: ToolAuthorizationHook,
    onRejected?: ToolRejectionHook,
    onExecutionActivity?: ToolExecutionActivityHook,
  ) {
    const prepared = prepareToolDefinitions(definitions);
    this.#definitions = prepared.definitions;
    this.#byName = prepared.byName;
    this.#policy = policy;
    this.#runtimeVersion = runtimeVersion;
    this.#authorize = authorize;
    this.#onRejected = onRejected;
    this.#onExecutionActivity = onExecutionActivity;
    this.#manifest = buildToolManifest(
      runtimeVersion,
      this.#definitions.map((definition) => definition.spec),
    );
  }

  get definitions(): readonly RuntimeToolDefinition[] {
    return this.#definitions;
  }

  get manifest(): ToolManifest {
    return this.#manifest;
  }

  subscribe(listener: ToolCatalogChangeListener): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  replaceDefinitions(
    definitions: readonly RuntimeToolDefinition[],
  ): ToolCatalogReplacement {
    const prepared = prepareToolDefinitions(definitions);
    const previousManifest = this.#manifest;
    const nextManifest = buildToolManifest(
      this.#runtimeVersion,
      prepared.definitions.map((definition) => definition.spec),
    );
    const previousByName = this.#byName;
    const added = [...prepared.byName.keys()]
      .filter((name) => !previousByName.has(name))
      .sort();
    const removed = [...previousByName.keys()]
      .filter((name) => !prepared.byName.has(name))
      .sort();
    const updated = [...prepared.byName.entries()]
      .filter(([name, definition]) => {
        const previous = previousByName.get(name);
        return (
          previous !== undefined &&
          canonicalJson(previous.spec) !== canonicalJson(definition.spec)
        );
      })
      .map(([name]) => name)
      .sort();

    this.#definitions = prepared.definitions;
    this.#byName = prepared.byName;
    if (nextManifest.digest === previousManifest.digest) {
      return {
        changed: false,
        manifest: previousManifest,
        added: [],
        removed: [],
        updated: [],
      };
    }

    this.#manifest = nextManifest;
    const change: ToolCatalogChange = {
      previousManifest,
      manifest: nextManifest,
      added,
      removed,
      updated,
    };
    for (const listener of [...this.#changeListeners]) {
      try {
        listener(change);
      } catch {
        // A notification consumer must not roll back an already validated catalog swap.
      }
    }
    return {
      changed: true,
      manifest: nextManifest,
      added,
      removed,
      updated,
    };
  }

  async #reportRejection(request: ToolRejectionRequest): Promise<void> {
    if (this.#onRejected === undefined) {
      return;
    }
    try {
      await this.#onRejected(request);
    } catch {
      // Rejection telemetry must never replace the original policy/schema error.
    }
  }

  async #reportExecutionActivity(event: ToolExecutionActivityEvent): Promise<void> {
    if (this.#onExecutionActivity === undefined) {
      return;
    }
    try {
      await this.#onExecutionActivity(event);
    } catch (error) {
      if (event.toolName === "terminal.exec") {
        throw terminalEvidencePersistenceError(error);
      }
      // Non-terminal activity telemetry must never replace the tool result.
    }
  }

  async invoke(
    toolName: string,
    context: ToolExecutionContext,
    rawInput: unknown,
  ): Promise<unknown> {
    const definition = this.#byName.get(toolName);
    if (definition === undefined) {
      const error = new RuntimeError(
        "TOOL_NOT_FOUND",
        `Unknown tool: ${toolName}`,
        404,
      );
      await this.#reportRejection({
        principal: context.principal,
        toolName,
        stage: "lookup",
        error,
      });
      throw error;
    }

    let input: Record<string, unknown>;
    try {
      input = definition.parse(rawInput);
    } catch (error) {
      const runtimeError =
        error instanceof z.ZodError
          ? new RuntimeError(
              "INVALID_INPUT",
              "Tool input failed schema validation.",
              400,
              {
                issues: error.issues.map((issue) => ({
                  code: issue.code,
                  path: issue.path,
                  message: issue.message,
                })),
              },
            )
          : error instanceof RuntimeError
            ? error
            : new RuntimeError(
                "INVALID_INPUT",
                "Tool input failed validation.",
                400,
              );
      await this.#reportRejection({
        principal: context.principal,
        toolName,
        spec: definition.spec,
        stage: "schema",
        error: runtimeError,
      });
      throw runtimeError;
    }

    const workspaceId = definition.workspaceId(input);
    try {
      this.#policy.require(
        context.principal,
        definition.spec.requiredCapabilities,
        workspaceId,
      );
    } catch (error) {
      const runtimeError = error instanceof RuntimeError
        ? error
        : new RuntimeError("POLICY_DENIED", "Tool policy rejected the call.", 403);
      await this.#reportRejection({
        principal: context.principal,
        toolName,
        spec: definition.spec,
        stage: "policy",
        error: runtimeError,
        input,
      });
      throw runtimeError;
    }

    try {
      await this.#authorize?.({
        principal: context.principal,
        spec: definition.spec,
        input,
      });
    } catch (error) {
      const runtimeError = error instanceof RuntimeError
        ? error
        : new RuntimeError("POLICY_DENIED", "Tool authorization rejected the call.", 403);
      await this.#reportRejection({
        principal: context.principal,
        toolName,
        spec: definition.spec,
        stage: "authorization",
        error: runtimeError,
        input,
      });
      throw runtimeError;
    }
    const activityId = randomUUID();
    const startedAt = new Date();
    const baseActivity = {
      id: activityId,
      principalId: context.principal.id,
      sessionId: context.sessionId ?? null,
      toolName: definition.spec.name,
      title: definition.spec.title,
      category: definition.spec.category,
      workspaceId: workspaceId ?? null,
      startedAt: startedAt.toISOString(),
    } as const;
    await this.#reportExecutionActivity({
      ...baseActivity,
      phase: "started",
      completedAt: null,
      durationMs: null,
      outcome: null,
      errorCode: null,
      receiptId: null,
    });
    try {
      const result = await definition.execute(context, input);
      const completedAt = new Date();
      await this.#reportExecutionActivity({
        ...baseActivity,
        phase: "completed",
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        outcome: "succeeded",
        errorCode: null,
        receiptId: toolExecutionReceiptId(result),
      });
      return result;
    } catch (error) {
      const completedAt = new Date();
      await this.#reportExecutionActivity({
        ...baseActivity,
        phase: "completed",
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        outcome: "failed",
        errorCode: error instanceof RuntimeError ? error.code : "INTERNAL_ERROR",
        receiptId: toolExecutionReceiptId(error),
      });
      throw error;
    }
  }
}

const workspaceId = z.string().min(1).max(128);
const relativePath = z.string().max(4_096);
const requiredRelativePath = z.string().min(1).max(4_096);
const runId = z.string().min(1).max(128);
const workflowStep = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("validation"), task: z.enum(["typecheck", "test", "build"]) }).strict(),
  z.object({ kind: z.literal("terminal"), command: z.string().min(1).max(8_192) }).strict(),
  z.object({ kind: z.literal("python"), code: z.string().min(1).max(32_768) }).strict(),
]);
const computerAction = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("focus_window"), windowId: z.string().min(1).max(32) }).strict(),
  z.object({ operation: z.literal("click"), x: z.number().int(), y: z.number().int() }).strict(),
  z.object({ operation: z.literal("type_text"), text: z.string().min(1).max(32_768) }).strict(),
  z.object({ operation: z.literal("press_key"), key: z.string().min(1).max(32) }).strict(),
  z.object({ operation: z.literal("launch_application"), path: requiredRelativePath }).strict(),
]);

export function createBuiltinTools(adapter: WindowsAdapter): readonly RuntimeToolDefinition[] {
  return [
    defineTool(
      {
        name: "system.info",
        version: "1.0.0",
        title: "System information",
        description: "Return bounded local runtime and Windows platform metadata.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({}, []),
      },
      {},
      ({ principal }) => adapter.systemInfo(principal),
    ),
    defineTool(
      {
        name: "system.audit_receipts",
        version: "1.0.0",
        title: "Audit receipts",
        description: "List recent immutable write-operation receipts.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            limit: { type: "integer", minimum: 1, maximum: 1_000 },
          },
          [],
        ),
      },
      { limit: z.number().int().min(1).max(1_000).optional() },
      ({ principal }, input) => adapter.listAuditReceipts(principal, input.limit ?? 100),
    ),
    defineTool(
      {
        name: "system.notify",
        version: "1.0.0",
        title: "Show Windows notification",
        description: "Show one bounded local Windows notification when a project or Task reaches a meaningful work node, completes, or needs operator attention. Never include credentials, access tokens, one-time codes, or other secrets.",
        category: "system",
        requiredCapabilities: ["system.notify"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema(
          {
            title: { type: "string", minLength: 1, maxLength: 64 },
            message: { type: "string", minLength: 1, maxLength: 512 },
            severity: {
              type: "string",
              enum: ["info", "success", "warning", "error"],
              default: "info",
            },
            durationMs: {
              type: "integer",
              minimum: 3_000,
              maximum: 15_000,
              default: 6_000,
            },
          },
          ["title", "message"],
        ),
      },
      {
        title: z.string().min(1).max(64),
        message: z.string().min(1).max(512),
        severity: z.enum(["info", "success", "warning", "error"]).optional(),
        durationMs: z.number().int().min(3_000).max(15_000).optional(),
      },
      ({ principal }, input) => adapter.notifyDesktop(principal, {
        title: input.title,
        message: input.message,
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      }),
    ),
    defineTool(
      {
        name: "workspace.list",
        version: "1.0.0",
        title: "List workspace",
        description: "List direct entries beneath an allowlisted workspace path.",
        category: "workspace",
        requiredCapabilities: ["workspace.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", maxLength: 4_096, default: "" },
          },
          ["workspaceId"],
        ),
      },
      { workspaceId, path: relativePath.optional() },
      ({ principal }, input) =>
        adapter.listWorkspace(principal, input.workspaceId, input.path ?? ""),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "workspace.tree",
        version: "1.0.0",
        title: "Workspace tree",
        description: "Return a bounded recursive tree without following symbolic links or junctions.",
        category: "workspace",
        requiredCapabilities: ["workspace.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", maxLength: 4_096, default: "" },
            maxDepth: { type: "integer", minimum: 1, maximum: 4, default: 3 },
            maxEntries: { type: "integer", minimum: 1, maximum: 500, default: 200 },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        path: relativePath.optional(),
        maxDepth: z.number().int().min(1).max(4).optional(),
        maxEntries: z.number().int().min(1).max(500).optional(),
      },
      ({ principal }, input) =>
        adapter.workspaceTree(
          principal,
          input.workspaceId,
          input.path ?? "",
          input.maxDepth ?? 3,
          input.maxEntries ?? 200,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "files.read",
        version: "1.0.0",
        title: "Read text file",
        description: "Read one contained regular UTF-8 file and return its SHA-256 digest.",
        category: "files",
        requiredCapabilities: ["files.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", minLength: 1, maxLength: 4_096 },
            maxBytes: { type: "integer", minimum: 1, maximum: 262_144 },
          },
          ["workspaceId", "path"],
        ),
      },
      {
        workspaceId,
        path: requiredRelativePath,
        maxBytes: z.number().int().min(1).max(262_144).optional(),
      },
      ({ principal }, input) =>
        adapter.readTextFile(principal, input.workspaceId, input.path, input.maxBytes),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "files.metadata",
        version: "1.0.0",
        title: "File metadata",
        description: "Return contained file or directory metadata and a digest for bounded regular files.",
        category: "files",
        requiredCapabilities: ["files.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          path: { type: "string", minLength: 1, maxLength: 4_096 },
        }),
      },
      { workspaceId, path: requiredRelativePath },
      ({ principal }, input) =>
        adapter.fileMetadata(principal, input.workspaceId, input.path),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "files.create",
        version: "1.0.0",
        title: "Create text file",
        description: "Create one new contained UTF-8 file without overwriting an existing path.",
        category: "files",
        requiredCapabilities: ["files.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          path: { type: "string", minLength: 1, maxLength: 4_096 },
          content: { type: "string", maxLength: 1_048_576 },
        }),
      },
      {
        workspaceId,
        path: requiredRelativePath,
        content: z.string().max(1_048_576),
      },
      ({ principal }, input) =>
        adapter.createTextFile(principal, input.workspaceId, input.path, input.content),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "files.mkdir",
        version: "1.0.0",
        title: "Create directory",
        description: "Create one contained directory beneath an existing authorized parent.",
        category: "files",
        requiredCapabilities: ["files.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          path: { type: "string", minLength: 1, maxLength: 4_096 },
        }),
      },
      { workspaceId, path: requiredRelativePath },
      ({ principal }, input) =>
        adapter.createDirectory(principal, input.workspaceId, input.path),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "files.replace",
        version: "1.0.0",
        title: "Guarded text replacement",
        description: "Replace one contained UTF-8 file only when its current SHA-256 matches.",
        category: "files",
        requiredCapabilities: ["files.write"],
        sideEffect: "write",
        destructive: true,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          path: { type: "string", minLength: 1, maxLength: 4_096 },
          content: { type: "string", maxLength: 1_048_576 },
          expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        }),
      },
      {
        workspaceId,
        path: requiredRelativePath,
        content: z.string().max(1_048_576),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
      },
      ({ principal }, input) =>
        adapter.replaceTextFile(
          principal,
          input.workspaceId,
          input.path,
          input.content,
          input.expectedSha256,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "files.replace_text",
        version: "1.0.0",
        title: "Guarded exact text replacement",
        description: "Replace the first or every exact text occurrence only when the current file digest matches.",
        category: "files",
        requiredCapabilities: ["files.read", "files.write"],
        sideEffect: "write",
        destructive: true,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", minLength: 1, maxLength: 4_096 },
            findText: { type: "string", minLength: 1, maxLength: 100_000 },
            replacementText: { type: "string", maxLength: 1_048_576 },
            expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            occurrence: { type: "string", enum: ["first", "all"], default: "first" },
          },
          ["workspaceId", "path", "findText", "replacementText", "expectedSha256"],
        ),
      },
      {
        workspaceId,
        path: requiredRelativePath,
        findText: z.string().min(1).max(100_000),
        replacementText: z.string().max(1_048_576),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
        occurrence: z.enum(["first", "all"]).optional(),
      },
      ({ principal }, input) =>
        adapter.replaceTextInFile(
          principal,
          input.workspaceId,
          input.path,
          input.findText,
          input.replacementText,
          input.expectedSha256,
          input.occurrence ?? "first",
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "files.move",
        version: "1.0.0",
        title: "Guarded file move",
        description: "Move one contained regular file to a new non-existing path when its SHA-256 matches.",
        category: "files",
        requiredCapabilities: ["files.read", "files.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          sourcePath: { type: "string", minLength: 1, maxLength: 4_096 },
          destinationPath: { type: "string", minLength: 1, maxLength: 4_096 },
          expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        }),
      },
      {
        workspaceId,
        sourcePath: requiredRelativePath,
        destinationPath: requiredRelativePath,
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
      },
      ({ principal }, input) =>
        adapter.moveFile(
          principal,
          input.workspaceId,
          input.sourcePath,
          input.destinationPath,
          input.expectedSha256,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "files.delete",
        version: "1.0.0",
        title: "Guarded file deletion",
        description: "Delete one contained regular file only when its current SHA-256 matches.",
        category: "files",
        requiredCapabilities: ["files.read", "files.write", "files.destructive"],
        sideEffect: "write",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          path: { type: "string", minLength: 1, maxLength: 4_096 },
          expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        }),
      },
      {
        workspaceId,
        path: requiredRelativePath,
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
      },
      ({ principal }, input) =>
        adapter.deleteFile(
          principal,
          input.workspaceId,
          input.path,
          input.expectedSha256,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "search.text",
        version: "1.0.0",
        title: "Search workspace text",
        description: "Search bounded text files without following links or entering excluded build trees.",
        category: "search",
        requiredCapabilities: ["search.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            query: { type: "string", minLength: 1, maxLength: 1_000 },
            path: { type: "string", maxLength: 4_096, default: "" },
            maxResults: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
          ["workspaceId", "query"],
        ),
      },
      {
        workspaceId,
        query: z.string().min(1).max(1_000),
        path: relativePath.optional(),
        maxResults: z.number().int().min(1).max(200).optional(),
      },
      ({ principal }, input) =>
        adapter.searchText(
          principal,
          input.workspaceId,
          input.query,
          input.path ?? "",
          input.maxResults ?? 50,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.status",
        version: "1.0.0",
        title: "Git status",
        description: "Run a fixed read-only git status operation in an allowlisted workspace.",
        category: "git",
        requiredCapabilities: ["git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId },
      ({ principal }, input) => adapter.gitStatus(principal, input.workspaceId),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.diff",
        version: "1.0.0",
        title: "Git diff",
        description: "Read a bounded unstaged or staged diff, optionally limited to one contained path.",
        category: "git",
        requiredCapabilities: ["git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", minLength: 1, maxLength: 4_096 },
            staged: { type: "boolean", default: false },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        path: requiredRelativePath.optional(),
        staged: z.boolean().optional(),
      },
      ({ principal }, input) =>
        adapter.gitDiff(principal, input.workspaceId, input.path, input.staged ?? false),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.log",
        version: "1.0.0",
        title: "Git log",
        description: "Read a bounded local commit history without accepting arbitrary Git arguments.",
        category: "git",
        requiredCapabilities: ["git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            maxCount: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        maxCount: z.number().int().min(1).max(200).optional(),
      },
      ({ principal }, input) =>
        adapter.gitLog(principal, input.workspaceId, input.maxCount ?? 50),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.stage",
        version: "1.0.0",
        title: "Stage Git paths",
        description: "Stage an explicit bounded set of repository-relative paths for a local commit.",
        category: "git",
        requiredCapabilities: ["git.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          files: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { type: "string", minLength: 1, maxLength: 4_096 },
          },
        }),
      },
      {
        workspaceId,
        files: z.array(requiredRelativePath).min(1).max(100),
      },
      ({ principal }, input) => adapter.gitStage(principal, input.workspaceId, input.files),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.commit",
        version: "1.0.0",
        title: "Create local Git commit",
        description: "Create one local commit from already staged changes with hooks and signing disabled.",
        category: "git",
        requiredCapabilities: ["git.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          message: { type: "string", minLength: 1, maxLength: 4_000 },
        }),
      },
      {
        workspaceId,
        message: z.string().min(1).max(4_000),
      },
      ({ principal }, input) => adapter.gitCommit(principal, input.workspaceId, input.message),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "python.capabilities",
        version: "1.0.0",
        title: "Python capabilities",
        description: "Probe fixed Python 3 launcher candidates and report isolated-execution availability without running caller code.",
        category: "python",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId },
      ({ principal }, input) => adapter.pythonCapabilities(principal, input.workspaceId),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "python.start",
        version: "1.0.0",
        title: "Start Python run",
        description: "Start trusted inline or workspace-script Python as a cancellable isolated-mode run. Host networking is not sandboxed.",
        category: "python",
        requiredCapabilities: ["python.run"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            mode: { type: "string", enum: ["code", "script"] },
            code: { type: "string", minLength: 1, maxLength: 1_048_576 },
            scriptPath: { type: "string", minLength: 1, maxLength: 4_096 },
            arguments: {
              type: "array",
              maxItems: 128,
              items: { type: "string", maxLength: 4_096 },
              default: [],
            },
            cwd: { type: "string", maxLength: 4_096, default: "" },
            artifactPaths: {
              type: "array",
              maxItems: 64,
              items: { type: "string", minLength: 1, maxLength: 4_096 },
              default: [],
            },
            timeoutMs: { type: "integer", minimum: 1_000, maximum: 900_000, default: 120_000 },
          },
          ["workspaceId", "mode"],
        ),
      },
      {
        workspaceId,
        mode: z.enum(["code", "script"]),
        code: z.string().min(1).max(1_048_576).optional(),
        scriptPath: requiredRelativePath.optional(),
        arguments: z.array(z.string().max(4_096)).max(128).optional(),
        cwd: relativePath.optional(),
        artifactPaths: z.array(requiredRelativePath).max(64).optional(),
        timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
      },
      ({ principal }, input) =>
        adapter.startPythonRun(
          principal,
          input.workspaceId,
          input.mode,
          input.code,
          input.scriptPath,
          input.arguments ?? [],
          input.cwd ?? "",
          input.artifactPaths ?? [],
          input.timeoutMs ?? 120_000,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "runs.list",
        version: "1.0.0",
        title: "List runs",
        description: "List bounded background-run summaries for one authorized workspace.",
        category: "runs",
        requiredCapabilities: ["runs.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        limit: z.number().int().min(1).max(500).optional(),
      },
      ({ principal }, input) =>
        adapter.listRuns(principal, input.workspaceId, input.limit ?? 100),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "runs.get",
        version: "1.0.0",
        title: "Get run",
        description: "Read one background run with bounded stdout and stderr.",
        category: "runs",
        requiredCapabilities: ["runs.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          runId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId, runId },
      ({ principal }, input) => adapter.getRun(principal, input.workspaceId, input.runId),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "runs.wait",
        version: "1.0.0",
        title: "Wait for run",
        description: "Wait briefly for one background run to change or complete, then return its latest bounded state and output.",
        category: "runs",
        requiredCapabilities: ["runs.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            runId: { type: "string", minLength: 1, maxLength: 128 },
            waitMs: { type: "integer", minimum: 0, maximum: 25_000, default: 15_000 },
          },
          ["workspaceId", "runId"],
        ),
      },
      {
        workspaceId,
        runId,
        waitMs: z.number().int().min(0).max(25_000).optional(),
      },
      ({ principal }, input) =>
        adapter.waitRun(
          principal,
          input.workspaceId,
          input.runId,
          input.waitMs ?? 15_000,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "runs.follow",
        version: "1.0.0",
        title: "Follow run output",
        description:
          "Return only stdout and stderr bytes newer than an opaque run cursor, optionally waiting for new output or completion.",
        category: "runs",
        requiredCapabilities: ["runs.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            runId: { type: "string", minLength: 1, maxLength: 128 },
            cursor: { type: "string", minLength: 1, maxLength: 2_048 },
            waitMs: { type: "integer", minimum: 0, maximum: 25_000, default: 15_000 },
            maxBytes: { type: "integer", minimum: 256, maximum: 262_144, default: 65_536 },
          },
          ["workspaceId", "runId"],
        ),
      },
      {
        workspaceId,
        runId,
        cursor: z.string().min(1).max(2_048).optional(),
        waitMs: z.number().int().min(0).max(25_000).optional(),
        maxBytes: z.number().int().min(256).max(262_144).optional(),
      },
      ({ principal }, input) => adapter.followRun(
        principal,
        input.workspaceId,
        input.runId,
        input.cursor,
        input.waitMs ?? 15_000,
        input.maxBytes ?? 65_536,
      ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "runs.cancel",
        version: "1.0.0",
        title: "Cancel run",
        description: "Request bounded cancellation for one active workspace run.",
        category: "runs",
        requiredCapabilities: ["runs.cancel"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          runId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId, runId },
      ({ principal }, input) => adapter.cancelRun(principal, input.workspaceId, input.runId),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "validation.start",
        version: "1.0.0",
        title: "Start background validation",
        description: "Start typecheck, test, or build as a cancellable background run.",
        category: "validation",
        requiredCapabilities: ["validation.run"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            task: { type: "string", enum: ["typecheck", "test", "build"] },
            timeoutMs: { type: "integer", minimum: 1_000, maximum: 900_000, default: 120_000 },
          },
          ["workspaceId", "task"],
        ),
      },
      {
        workspaceId,
        task: z.enum(["typecheck", "test", "build"]),
        timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
      },
      ({ principal }, input) =>
        adapter.startValidationRun(
          principal,
          input.workspaceId,
          input.task,
          input.timeoutMs ?? 120_000,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "validation.run",
        version: "1.0.0",
        title: "Run fixed validation",
        description: "Run only the typecheck, test, or build package script; arbitrary shell input is not accepted.",
        category: "validation",
        requiredCapabilities: ["validation.run"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          task: { type: "string", enum: ["typecheck", "test", "build"] },
        }),
      },
      {
        workspaceId,
        task: z.enum(["typecheck", "test", "build"]),
      },
      ({ principal }, input) =>
        adapter.runValidation(principal, input.workspaceId, input.task),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "terminal.session.list",
        version: "1.0.0",
        title: "List interactive terminals",
        description: "List bounded ConPTY session summaries for the authorized workspace.",
        category: "terminal",
        requiredCapabilities: ["terminal.observe"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId },
      ({ principal }, input) => adapter.listTerminalSessions(principal, input.workspaceId),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "terminal.session.read",
        version: "1.0.0",
        title: "Read interactive terminal",
        description: "Read the latest bounded output and state for one ConPTY session.",
        category: "terminal",
        requiredCapabilities: ["terminal.observe"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId, sessionId: runId },
      ({ principal }, input) =>
        adapter.getTerminalSession(principal, input.workspaceId, input.sessionId),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "terminal.session.create",
        version: "1.0.0",
        title: "Create interactive terminal",
        description: "Create one approved Windows ConPTY Command Prompt session in a contained workspace directory.",
        category: "terminal",
        requiredCapabilities: ["terminal.run"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            cwd: { type: "string", maxLength: 4_096, default: "" },
            columns: { type: "integer", minimum: 20, maximum: 500, default: 120 },
            rows: { type: "integer", minimum: 5, maximum: 200, default: 32 },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        cwd: relativePath.optional(),
        columns: z.number().int().min(20).max(500).optional(),
        rows: z.number().int().min(5).max(200).optional(),
      },
      ({ principal }, input) =>
        adapter.createTerminalSession(
          principal,
          input.workspaceId,
          input.cwd ?? "",
          input.columns ?? 120,
          input.rows ?? 32,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "terminal.session.write",
        version: "1.0.0",
        title: "Write interactive terminal input",
        description: "Write one approved text payload to a live ConPTY session, optionally submitting Enter.",
        category: "terminal",
        requiredCapabilities: ["terminal.run"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            sessionId: { type: "string", minLength: 1, maxLength: 128 },
            data: { type: "string", minLength: 1, maxLength: 32_768 },
            appendEnter: { type: "boolean", default: true },
          },
          ["workspaceId", "sessionId", "data"],
        ),
      },
      {
        workspaceId,
        sessionId: runId,
        data: z.string().min(1).max(32_768),
        appendEnter: z.boolean().optional(),
      },
      ({ principal }, input) =>
        adapter.writeTerminalSession(
          principal,
          input.workspaceId,
          input.sessionId,
          input.data,
          input.appendEnter ?? true,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "terminal.session.resize",
        version: "1.0.0",
        title: "Resize interactive terminal",
        description: "Resize one approved ConPTY session.",
        category: "terminal",
        requiredCapabilities: ["terminal.run"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
          columns: { type: "integer", minimum: 20, maximum: 500 },
          rows: { type: "integer", minimum: 5, maximum: 200 },
        }),
      },
      {
        workspaceId,
        sessionId: runId,
        columns: z.number().int().min(20).max(500),
        rows: z.number().int().min(5).max(200),
      },
      ({ principal }, input) =>
        adapter.resizeTerminalSession(
          principal,
          input.workspaceId,
          input.sessionId,
          input.columns,
          input.rows,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "terminal.session.close",
        version: "1.0.0",
        title: "Close interactive terminal",
        description: "Close one approved ConPTY session and its process tree.",
        category: "terminal",
        requiredCapabilities: ["terminal.run"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId, sessionId: runId },
      ({ principal }, input) =>
        adapter.closeTerminalSession(principal, input.workspaceId, input.sessionId),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "browser.capabilities",
        version: "1.0.0",
        title: "Managed browser capabilities",
        description: "Report local Microsoft Edge CDP availability and policy defaults.",
        category: "browser",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({}, []),
      },
      {},
      ({ principal }) => adapter.browserCapabilities(principal),
    ),
    defineTool(
      {
        name: "browser.session.list",
        version: "1.0.0",
        title: "List managed browser sessions",
        description: "List managed browser sessions without exposing profile storage.",
        category: "browser",
        requiredCapabilities: ["browser.observe"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId },
      ({ principal }, input) => adapter.listBrowserSessions(principal, input.workspaceId),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "browser.session.create",
        version: "1.0.0",
        title: "Create managed browser session",
        description: "Create an isolated headless Edge session with an explicit domain allowlist.",
        category: "browser",
        requiredCapabilities: ["browser.control", "network.access"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          allowedDomains: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 253 },
          },
        }),
      },
      {
        workspaceId,
        allowedDomains: z.array(z.string().min(1).max(253)).min(1).max(64),
      },
      ({ principal }, input) =>
        adapter.createBrowserSession(principal, input.workspaceId, input.allowedDomains),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "browser.navigate",
        version: "1.0.0",
        title: "Navigate managed browser",
        description: "Navigate within a managed session after enforcing its domain allowlist.",
        category: "browser",
        requiredCapabilities: ["browser.control", "network.access"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
          url: { type: "string", minLength: 1, maxLength: 2_048 },
        }),
      },
      { workspaceId, sessionId: runId, url: z.string().min(1).max(2_048) },
      ({ principal }, input) =>
        adapter.navigateBrowser(principal, input.workspaceId, input.sessionId, input.url),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "browser.observe",
        version: "1.0.0",
        title: "Observe managed browser",
        description: "Read bounded page text, accessibility nodes, URL, title, and an optional JPEG screenshot.",
        category: "browser",
        requiredCapabilities: ["browser.observe"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            sessionId: { type: "string", minLength: 1, maxLength: 128 },
            includeScreenshot: { type: "boolean", default: false },
          },
          ["workspaceId", "sessionId"],
        ),
      },
      { workspaceId, sessionId: runId, includeScreenshot: z.boolean().optional() },
      ({ principal }, input) =>
        adapter.observeBrowser(
          principal,
          input.workspaceId,
          input.sessionId,
          input.includeScreenshot ?? false,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "browser.click",
        version: "1.0.0",
        title: "Click managed browser element",
        description: "Click one element ref from the latest browser observation; stale revisions are rejected and all resulting requests remain domain-scoped.",
        category: "browser",
        requiredCapabilities: ["browser.control", "network.access"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
          expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
          ref: { type: "string", pattern: "^e[0-9]{1,4}$" },
        }),
      },
      {
        workspaceId,
        sessionId: runId,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
        ref: z.string().regex(/^e\d{1,4}$/),
      },
      ({ principal }, input) =>
        adapter.clickBrowser(
          principal,
          input.workspaceId,
          input.sessionId,
          input.expectedRevision,
          input.ref,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "browser.type",
        version: "1.0.0",
        title: "Type into managed browser element",
        description: "Type into one editable element ref from the latest observation. Credential and one-time-code fields are denied for human handoff.",
        category: "browser",
        requiredCapabilities: ["browser.control", "network.access"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            sessionId: { type: "string", minLength: 1, maxLength: 128 },
            expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
            ref: { type: "string", pattern: "^e[0-9]{1,4}$" },
            text: { type: "string", maxLength: 32_768 },
            replace: { type: "boolean", default: true },
            submit: { type: "boolean", default: false },
          },
          ["workspaceId", "sessionId", "expectedRevision", "ref", "text"],
        ),
      },
      {
        workspaceId,
        sessionId: runId,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
        ref: z.string().regex(/^e\d{1,4}$/),
        text: z.string().max(32_768),
        replace: z.boolean().optional(),
        submit: z.boolean().optional(),
      },
      ({ principal }, input) =>
        adapter.typeBrowser(
          principal,
          input.workspaceId,
          input.sessionId,
          input.expectedRevision,
          input.ref,
          input.text,
          input.replace ?? true,
          input.submit ?? false,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "browser.evaluate",
        version: "1.0.0",
        title: "Evaluate managed browser script",
        description: "Evaluate one approved JavaScript expression in the managed page and return a bounded value.",
        category: "browser",
        requiredCapabilities: ["browser.control"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
          expression: { type: "string", minLength: 1, maxLength: 32_768 },
        }),
      },
      {
        workspaceId,
        sessionId: runId,
        expression: z.string().min(1).max(32_768),
      },
      ({ principal }, input) =>
        adapter.evaluateBrowser(
          principal,
          input.workspaceId,
          input.sessionId,
          input.expression,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "browser.session.close",
        version: "1.0.0",
        title: "Close managed browser session",
        description: "Close one managed Edge process and delete its temporary profile.",
        category: "browser",
        requiredCapabilities: ["browser.control"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId, sessionId: runId },
      ({ principal }, input) =>
        adapter.closeBrowserSession(principal, input.workspaceId, input.sessionId),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "workflow.templates",
        version: "1.0.0",
        title: "Workflow templates",
        description: "Return built-in self-hosting workflow templates without executing them.",
        category: "workflow",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({}, []),
      },
      {},
      ({ principal }) => adapter.workflowTemplates(principal),
    ),
    defineTool(
      {
        name: "workflow.start",
        version: "1.0.0",
        title: "Start workflow",
        description: "Start an approved sequential validation, PowerShell, and Python workflow as one cancellable run.",
        category: "workflow",
        requiredCapabilities: ["workflow.run"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            label: { type: "string", minLength: 1, maxLength: 200 },
            steps: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                oneOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: { const: "validation" },
                      task: { type: "string", enum: ["typecheck", "test", "build"] },
                    },
                    required: ["kind", "task"],
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: { const: "terminal" },
                      command: { type: "string", minLength: 1, maxLength: 8_192 },
                    },
                    required: ["kind", "command"],
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: { const: "python" },
                      code: { type: "string", minLength: 1, maxLength: 32_768 },
                    },
                    required: ["kind", "code"],
                  },
                ],
              },
            },
            cwd: { type: "string", maxLength: 4_096, default: "" },
            timeoutMs: { type: "integer", minimum: 1_000, maximum: 3_600_000, default: 900_000 },
          },
          ["workspaceId", "label", "steps"],
        ),
      },
      {
        workspaceId,
        label: z.string().min(1).max(200),
        steps: z.array(workflowStep).min(1).max(20),
        cwd: relativePath.optional(),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
      },
      ({ principal }, input) =>
        adapter.startWorkflowRun(
          principal,
          input.workspaceId,
          input.label,
          input.steps,
          input.cwd ?? "",
          input.timeoutMs ?? 900_000,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "computer.capabilities",
        version: "1.0.0",
        title: "Computer-use capabilities",
        description: "Report native Windows observation and action availability.",
        category: "computer",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({}, []),
      },
      {},
      ({ principal }) => adapter.computerCapabilities(principal),
    ),
    defineTool(
      {
        name: "computer.observe",
        version: "1.0.0",
        title: "Observe Windows desktop",
        description:
          "Capture revision-bound virtual-screen geometry, visible windows, and an optional JPEG screenshot of the whole desktop.",
        category: "computer",
        requiredCapabilities: ["computer.observe"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            includeScreenshot: { type: "boolean", default: false },
          },
          ["workspaceId"],
        ),
      },
      { workspaceId, includeScreenshot: z.boolean().optional() },
      ({ principal }, input) =>
        adapter.observeComputer(principal, input.workspaceId, input.includeScreenshot ?? false),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "computer.action",
        version: "1.0.0",
        title: "Act on Windows desktop",
        description: "Execute one approved revision-bound focus, click, text, key, or contained-application launch action.",
        category: "computer",
        requiredCapabilities: ["computer.control"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
          action: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  operation: { const: "focus_window" },
                  windowId: { type: "string", minLength: 1, maxLength: 32 },
                },
                required: ["operation", "windowId"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  operation: { const: "click" },
                  x: { type: "integer" },
                  y: { type: "integer" },
                },
                required: ["operation", "x", "y"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  operation: { const: "type_text" },
                  text: { type: "string", minLength: 1, maxLength: 32_768 },
                },
                required: ["operation", "text"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  operation: { const: "press_key" },
                  key: { type: "string", minLength: 1, maxLength: 32 },
                },
                required: ["operation", "key"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  operation: { const: "launch_application" },
                  path: { type: "string", minLength: 1, maxLength: 4_096 },
                },
                required: ["operation", "path"],
              },
            ],
          },
        }),
      },
      {
        workspaceId,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
        action: computerAction,
      },
      ({ principal }, input) =>
        adapter.actComputer(
          principal,
          input.workspaceId,
          input.expectedRevision,
          input.action,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "terminal.start",
        version: "1.0.0",
        title: "Start PowerShell run",
        description: "Start one approved non-interactive PowerShell command as a cancellable background run from a contained workspace directory.",
        category: "terminal",
        requiredCapabilities: ["terminal.run"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            command: { type: "string", minLength: 1, maxLength: 32_768 },
            cwd: { type: "string", maxLength: 4_096, default: "" },
            timeoutMs: { type: "integer", minimum: 1_000, maximum: 300_000, default: 120_000 },
          },
          ["workspaceId", "command"],
        ),
      },
      {
        workspaceId,
        command: z.string().min(1).max(32_768),
        cwd: relativePath.optional(),
        timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
      },
      ({ principal }, input) =>
        adapter.startTerminalRun(
          principal,
          input.workspaceId,
          input.command,
          input.cwd ?? "",
          input.timeoutMs ?? 120_000,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "terminal.exec",
        version: "1.0.0",
        title: "Run PowerShell command",
        description: "Run one approved non-interactive PowerShell command from a contained workspace directory. The command itself is not filesystem-sandboxed.",
        category: "terminal",
        requiredCapabilities: ["terminal.run"],
        sideEffect: "process",
        destructive: true,
        permissionLevel: "consequential",
        approvalMode: "single-use",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            command: { type: "string", minLength: 1, maxLength: 32_768 },
            cwd: { type: "string", maxLength: 4_096, default: "" },
            timeoutMs: { type: "integer", minimum: 1_000, maximum: 300_000, default: 120_000 },
          },
          ["workspaceId", "command"],
        ),
      },
      {
        workspaceId,
        command: z.string().min(1).max(32_768),
        cwd: relativePath.optional(),
        timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
      },
      async ({ principal }, input) =>
        requireSuccessfulTerminalExecution(
          await adapter.runTerminalCommand(
            principal,
            input.workspaceId,
            input.command,
            input.cwd ?? "",
            input.timeoutMs ?? 120_000,
          ),
        ),
      (input) => input.workspaceId,
    ),
  ];
}

export interface RuntimeToolPack {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly enabledByDefault: boolean;
  readonly definitions: readonly RuntimeToolDefinition[];
}

export function createDeveloperEssentialsToolPack(
  adapter: WindowsAdapter,
): RuntimeToolPack {
  const definitions: readonly RuntimeToolDefinition[] = [
    defineTool(
      {
        name: "system.capabilities",
        version: "1.0.0",
        title: "Runtime capability report",
        description:
          "Return one bounded report covering the active Windows, Python, managed-browser, and computer-use capability surfaces.",
        category: "system",
        requiredCapabilities: ["system.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId },
      async ({ principal }, input) => {
        const [system, python, browser, computer] = await Promise.all([
          adapter.systemInfo(principal),
          adapter.pythonCapabilities(principal, input.workspaceId),
          adapter.browserCapabilities(principal),
          adapter.computerCapabilities(principal),
        ]);
        return {
          generatedAt: new Date().toISOString(),
          system,
          python,
          browser,
          computer,
        };
      },
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "files.read_lines",
        version: "1.0.0",
        title: "Read numbered text lines",
        description:
          "Read one bounded line window from a contained UTF-8 file and return stable line numbers plus the current SHA-256 digest.",
        category: "files",
        requiredCapabilities: ["files.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", minLength: 1, maxLength: 4_096 },
            startLine: { type: "integer", minimum: 1, maximum: 1_000_000, default: 1 },
            lineCount: { type: "integer", minimum: 1, maximum: 2_000, default: 200 },
            maxBytes: { type: "integer", minimum: 1, maximum: 262_144, default: 262_144 },
          },
          ["workspaceId", "path"],
        ),
      },
      {
        workspaceId,
        path: requiredRelativePath,
        startLine: z.number().int().min(1).max(1_000_000).optional(),
        lineCount: z.number().int().min(1).max(2_000).optional(),
        maxBytes: z.number().int().min(1).max(262_144).optional(),
      },
      async ({ principal }, input) => {
        const read = await adapter.readTextFile(
          principal,
          input.workspaceId,
          input.path,
          input.maxBytes ?? 262_144,
        );
        const normalized = read.content.replace(/\r\n?/gu, "\n");
        const allLines = normalized.length === 0 ? [] : normalized.split("\n");
        if (allLines.length > 0 && normalized.endsWith("\n")) {
          allLines.pop();
        }
        const startLine = input.startLine ?? 1;
        const lineCount = input.lineCount ?? 200;
        const selected = allLines.slice(startLine - 1, startLine - 1 + lineCount);
        return {
          workspaceId: read.workspaceId,
          relativePath: read.relativePath,
          bytes: read.bytes,
          sha256: read.sha256,
          totalLines: allLines.length,
          startLine,
          endLine: selected.length === 0 ? null : startLine + selected.length - 1,
          hasMore: startLine - 1 + selected.length < allLines.length,
          lines: selected.map((text, index) => ({
            line: startLine + index,
            text,
          })),
        };
      },
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "workspace.context",
        version: "1.0.0",
        title: "Workspace context",
        description:
          "Return a cursor-paginated repository map with branch, dirty files, Git-ignored file enumeration, matching paths, and bounded text snippets.",
        category: "workspace",
        requiredCapabilities: [
          "workspace.read",
          "files.read",
          "search.read",
          "git.read",
        ],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", maxLength: 4_096, default: "" },
            query: { type: "string", maxLength: 500 },
            cursor: { type: "string", minLength: 1, maxLength: 2_048 },
            maxFiles: { type: "integer", minimum: 1, maximum: 500, default: 80 },
            maxMatches: { type: "integer", minimum: 1, maximum: 200, default: 20 },
            snippetLines: { type: "integer", minimum: 0, maximum: 5, default: 1 },
            maxBytes: { type: "integer", minimum: 8_192, maximum: 262_144, default: 65_536 },
            includeUntracked: { type: "boolean", default: true },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        path: relativePath.optional(),
        query: z.string().max(500).optional(),
        cursor: z.string().min(1).max(2_048).optional(),
        maxFiles: z.number().int().min(1).max(500).optional(),
        maxMatches: z.number().int().min(1).max(200).optional(),
        snippetLines: z.number().int().min(0).max(5).optional(),
        maxBytes: z.number().int().min(8_192).max(262_144).optional(),
        includeUntracked: z.boolean().optional(),
      },
      ({ principal }, input) => adapter.workspaceContext(
        principal,
        input.workspaceId,
        input.path ?? "",
        input.query,
        input.cursor,
        input.maxFiles ?? 80,
        input.maxMatches ?? 20,
        input.snippetLines ?? 1,
        input.maxBytes ?? 65_536,
        input.includeUntracked ?? true,
      ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "workspace.snapshot",
        version: "1.0.0",
        title: "Workspace snapshot",
        description:
          "Return one bounded workspace tree together with the current local Git status for rapid project orientation.",
        category: "workspace",
        requiredCapabilities: ["workspace.read", "git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", maxLength: 4_096, default: "" },
            maxDepth: { type: "integer", minimum: 1, maximum: 4, default: 3 },
            maxEntries: {
              type: "integer",
              minimum: 1,
              maximum: 500,
              default: 200,
            },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        path: relativePath.optional(),
        maxDepth: z.number().int().min(1).max(4).optional(),
        maxEntries: z.number().int().min(1).max(500).optional(),
      },
      async ({ principal }, input) => {
        const [tree, git] = await Promise.all([
          adapter.workspaceTree(
            principal,
            input.workspaceId,
            input.path ?? "",
            input.maxDepth ?? 3,
            input.maxEntries ?? 200,
          ),
          adapter.gitStatus(principal, input.workspaceId),
        ]);
        return {
          generatedAt: new Date().toISOString(),
          tree,
          git,
        };
      },
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.summary",
        version: "1.0.0",
        title: "Git working summary",
        description:
          "Return bounded Git status, recent commit history, and a staged or unstaged diff in one read-only call.",
        category: "git",
        requiredCapabilities: ["git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", minLength: 1, maxLength: 4_096 },
            staged: { type: "boolean", default: false },
            maxCount: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        path: requiredRelativePath.optional(),
        staged: z.boolean().optional(),
        maxCount: z.number().int().min(1).max(50).optional(),
      },
      async ({ principal }, input) => {
        const [status, history, diff] = await Promise.all([
          adapter.gitStatus(principal, input.workspaceId),
          adapter.gitLog(principal, input.workspaceId, input.maxCount ?? 10),
          adapter.gitDiff(
            principal,
            input.workspaceId,
            input.path,
            input.staged ?? false,
          ),
        ]);
        return {
          generatedAt: new Date().toISOString(),
          status,
          history,
          diff,
        };
      },
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.show",
        version: "1.0.0",
        title: "Show Git revision",
        description:
          "Read a bounded commit or tree diff for one validated Git revision, optionally limited to one contained path.",
        category: "git",
        requiredCapabilities: ["git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            revision: { type: "string", minLength: 1, maxLength: 200, default: "HEAD" },
            path: { type: "string", minLength: 1, maxLength: 4_096 },
            statOnly: { type: "boolean", default: false },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        revision: z.string().min(1).max(200)
          .regex(/^[A-Za-z0-9@][A-Za-z0-9._/@{}^~+-]{0,199}$/u).optional(),
        path: requiredRelativePath.optional(),
        statOnly: z.boolean().optional(),
      },
      ({ principal }, input) => adapter.gitShow(
        principal,
        input.workspaceId,
        input.revision ?? "HEAD",
        input.path,
        input.statOnly ?? false,
      ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.blame",
        version: "1.0.0",
        title: "Git blame line range",
        description:
          "Read bounded line-porcelain authorship for one contained tracked file without accepting arbitrary Git arguments.",
        category: "git",
        requiredCapabilities: ["git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", minLength: 1, maxLength: 4_096 },
            startLine: { type: "integer", minimum: 1, maximum: 1_000_000, default: 1 },
            lineCount: { type: "integer", minimum: 1, maximum: 2_000, default: 200 },
          },
          ["workspaceId", "path"],
        ),
      },
      {
        workspaceId,
        path: requiredRelativePath,
        startLine: z.number().int().min(1).max(1_000_000).optional(),
        lineCount: z.number().int().min(1).max(2_000).optional(),
      },
      ({ principal }, input) => adapter.gitBlame(
        principal,
        input.workspaceId,
        input.path,
        input.startLine ?? 1,
        input.lineCount ?? 200,
      ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.branches",
        version: "1.0.0",
        title: "List Git branches",
        description:
          "List bounded local and optional remote branch metadata ordered by latest commit date.",
        category: "git",
        requiredCapabilities: ["git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            maxCount: { type: "integer", minimum: 1, maximum: 500, default: 100 },
            includeRemotes: { type: "boolean", default: true },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        maxCount: z.number().int().min(1).max(500).optional(),
        includeRemotes: z.boolean().optional(),
      },
      ({ principal }, input) => adapter.gitBranches(
        principal,
        input.workspaceId,
        input.maxCount ?? 100,
        input.includeRemotes ?? true,
      ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.tags",
        version: "1.0.0",
        title: "List Git tags",
        description: "List bounded tag metadata ordered by creator date.",
        category: "git",
        requiredCapabilities: ["git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            maxCount: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          },
          ["workspaceId"],
        ),
      },
      { workspaceId, maxCount: z.number().int().min(1).max(500).optional() },
      ({ principal }, input) =>
        adapter.gitTags(principal, input.workspaceId, input.maxCount ?? 100),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.worktrees",
        version: "1.0.0",
        title: "List Git worktrees",
        description: "Read the repository worktree registry in bounded porcelain form.",
        category: "git",
        requiredCapabilities: ["git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({
          workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
      { workspaceId },
      ({ principal }, input) => adapter.gitWorktrees(principal, input.workspaceId),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "git.files",
        version: "1.0.0",
        title: "List Git files",
        description:
          "List bounded tracked files and, when requested, untracked non-ignored files, optionally beneath one contained path.",
        category: "git",
        requiredCapabilities: ["git.read"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            path: { type: "string", minLength: 1, maxLength: 4_096 },
            includeUntracked: { type: "boolean", default: false },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        path: requiredRelativePath.optional(),
        includeUntracked: z.boolean().optional(),
      },
      ({ principal }, input) => adapter.gitFiles(
        principal,
        input.workspaceId,
        input.path,
        input.includeUntracked ?? false,
      ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "validation.verify",
        version: "1.0.0",
        title: "Start verification workflow",
        description:
          "Start a fixed, cancellable typecheck-and-test workflow without accepting arbitrary shell or Python input.",
        category: "validation",
        requiredCapabilities: ["validation.run", "workflow.run"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            cwd: { type: "string", maxLength: 4_096, default: "" },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: 3_600_000,
              default: 900_000,
            },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        cwd: relativePath.optional(),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
      },
      ({ principal }, input) =>
        adapter.startWorkflowRun(
          principal,
          input.workspaceId,
          "Typecheck and test",
          [
            { kind: "validation", task: "typecheck" },
            { kind: "validation", task: "test" },
          ],
          input.cwd ?? "",
          input.timeoutMs ?? 900_000,
        ),
      (input) => input.workspaceId,
    ),
    defineTool(
      {
        name: "validation.release_check",
        version: "1.0.0",
        title: "Start release-check workflow",
        description:
          "Start a fixed, cancellable typecheck, test, and build workflow without accepting arbitrary shell or Python input.",
        category: "validation",
        requiredCapabilities: ["validation.run", "workflow.run"],
        sideEffect: "process",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "session",
        inputSchema: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            cwd: { type: "string", maxLength: 4_096, default: "" },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: 3_600_000,
              default: 1_800_000,
            },
          },
          ["workspaceId"],
        ),
      },
      {
        workspaceId,
        cwd: relativePath.optional(),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
      },
      ({ principal }, input) =>
        adapter.startWorkflowRun(
          principal,
          input.workspaceId,
          "Typecheck, test, and build",
          [
            { kind: "validation", task: "typecheck" },
            { kind: "validation", task: "test" },
            { kind: "validation", task: "build" },
          ],
          input.cwd ?? "",
          input.timeoutMs ?? 1_800_000,
        ),
      (input) => input.workspaceId,
    ),
  ];

  return {
    id: "developer-essentials",
    version: "1.2.0",
    title: "Developer essentials",
    description:
      "Curated bounded tools for project orientation, cursor-paginated repository context, numbered file reads, Git history and reference inspection, capability discovery, and fixed verification workflows.",
    enabledByDefault: true,
    definitions,
  };
}
