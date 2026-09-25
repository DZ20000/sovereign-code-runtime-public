import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  RuntimeError,
  type AuditOutcome,
  type AuditStore,
} from "@sovereign/runtime-core";
import {
  defineTool,
  objectSchema,
  type RuntimeToolPack,
} from "@sovereign/toolkit";

import {
  CREDENTIAL_SERVICES,
  type CredentialReferenceSource,
  type CredentialReferenceStore,
} from "./credential-references.js";
import {
  type SandboxCollectionResult,
  type SandboxManager,
  type SandboxProcessResult,
  type SandboxSummary,
} from "./sandbox-manager.js";

const workspaceId = z.string().min(1).max(128);
const credentialId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u);
const sandboxId = z.string().uuid();
const credentialService = z.enum(CREDENTIAL_SERVICES);
const credentialSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github-cli") }).strict(),
  z
    .object({
      kind: z.literal("onepassword"),
      reference: z.string().min(1).max(1_024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("aws-secrets-manager"),
      reference: z.string().min(1).max(1_024),
    })
    .strict(),
]);

export interface SecureExecutionToolPackOptions {
  readonly credentialReferences: CredentialReferenceStore;
  readonly sandboxes: SandboxManager;
  readonly audit: AuditStore;
  readonly workspaceId: string;
}

interface AuditOperation<T> {
  readonly audit: AuditStore;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly toolName: string;
  readonly operation: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly execute: () => Promise<T> | T;
  readonly successDetails?: (value: T) => Readonly<Record<string, unknown>>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorCode(error: unknown): string {
  return error instanceof RuntimeError ? error.code : "INTERNAL_ERROR";
}

function auditOutcome(error: unknown): AuditOutcome {
  if (
    error instanceof RuntimeError &&
    ["AUTH_REQUIRED", "POLICY_DENIED"].includes(error.code)
  ) {
    return "denied";
  }
  return "failed";
}

function attachReceipt<T>(value: T, receiptId: string): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return {
      ...(value as Readonly<Record<string, unknown>>),
      receiptId,
    };
  }
  return { result: value, receiptId };
}

async function audited<T>(input: AuditOperation<T>): Promise<unknown> {
  const receiptId = randomUUID();
  const startedAt = Date.now();
  try {
    const value = await input.execute();
    input.audit.append({
      id: receiptId,
      occurredAt: new Date().toISOString(),
      principalId: input.principalId,
      toolName: input.toolName,
      operation: input.operation,
      outcome: "succeeded",
      workspaceId: input.workspaceId,
      details: {
        ...input.details,
        ...(input.successDetails?.(value) ?? {}),
        durationMs: Date.now() - startedAt,
      },
    });
    return attachReceipt(value, receiptId);
  } catch (error) {
    input.audit.append({
      id: receiptId,
      occurredAt: new Date().toISOString(),
      principalId: input.principalId,
      toolName: input.toolName,
      operation: input.operation,
      outcome: auditOutcome(error),
      workspaceId: input.workspaceId,
      errorCode: errorCode(error),
      details: {
        ...input.details,
        durationMs: Date.now() - startedAt,
      },
    });
    throw error;
  }
}

function sandboxResultDetails(
  result: SandboxProcessResult,
): Readonly<Record<string, unknown>> {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    processDurationMs: result.durationMs,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    outputTruncated: result.outputTruncated,
    timedOut: result.timedOut,
  };
}

function sandboxSummaryDetails(
  result: SandboxSummary,
): Readonly<Record<string, unknown>> {
  return {
    sandboxId: result.id,
    status: result.status,
    cpus: result.cpus,
    memoryMiB: result.memoryMiB,
    isolationMode: result.isolation.mode,
    network: result.isolation.network,
  };
}

function sandboxCollectionDetails(
  result: SandboxCollectionResult,
): Readonly<Record<string, unknown>> {
  return {
    sandboxId: result.sandboxId,
    collectionId: result.collectionId,
    refCount: result.refCount,
  };
}

export function createSecureExecutionToolPack(
  options: SecureExecutionToolPackOptions,
): RuntimeToolPack {
  return {
    id: "secure-execution",
    version: "1.1.0",
    title: "Secure execution",
    description:
      "Reviewed dynamic credential references and offline Docker microVM sandboxes with mandatory private-clone workspace isolation.",
    enabledByDefault: false,
    definitions: [
      defineTool(
        {
          name: "secrets.refs.list",
          version: "1.0.0",
          title: "List credential references",
          description:
            "List non-secret credential-reference metadata. Credential values are never returned by this or any other Sovereign tool.",
          category: "secrets",
          requiredCapabilities: ["secrets.read"],
          sideEffect: "read",
          destructive: false,
          permissionLevel: "observe",
          approvalMode: "none",
          inputSchema: objectSchema({}, []),
        },
        {},
        () => options.credentialReferences.status(),
      ),
      defineTool(
        {
          name: "secrets.refs.register",
          version: "1.0.0",
          title: "Register credential source",
          description:
            "Register or update an opaque dynamic credential source. Only fixed GitHub CLI, 1Password, and AWS Secrets Manager references are accepted; plaintext secret values are not accepted.",
          category: "secrets",
          requiredCapabilities: ["secrets.write"],
          sideEffect: "write",
          destructive: false,
          permissionLevel: "workspace",
          approvalMode: "session",
          inputSchema: objectSchema({
            id: {
              type: "string",
              minLength: 2,
              maxLength: 64,
              pattern: "^[a-z][a-z0-9-]{1,63}$",
            },
            label: { type: "string", minLength: 1, maxLength: 120 },
            service: { type: "string", enum: [...CREDENTIAL_SERVICES] },
            source: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: { kind: { const: "github-cli" } },
                  required: ["kind"],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { const: "onepassword" },
                    reference: {
                      type: "string",
                      minLength: 1,
                      maxLength: 1_024,
                    },
                  },
                  required: ["kind", "reference"],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { const: "aws-secrets-manager" },
                    reference: {
                      type: "string",
                      minLength: 1,
                      maxLength: 1_024,
                    },
                  },
                  required: ["kind", "reference"],
                },
              ],
            },
          }),
        },
        {
          id: credentialId,
          label: z.string().min(1).max(120),
          service: credentialService,
          source: credentialSource,
        },
        ({ principal }, input) =>
          audited({
            audit: options.audit,
            principalId: principal.id,
            workspaceId: options.workspaceId,
            toolName: "secrets.refs.register",
            operation: "register_credential_reference",
            details: {
              credentialId: input.id,
              service: input.service,
              sourceKind: input.source.kind,
              labelBytes: Buffer.byteLength(input.label, "utf8"),
              labelSha256: sha256(input.label),
            },
            execute: () =>
              options.credentialReferences.register({
                id: input.id,
                label: input.label,
                service: input.service,
                source: input.source as CredentialReferenceSource,
              }),
            successDetails: (value) => ({
              createdAt: value.createdAt,
              updatedAt: value.updatedAt,
            }),
          }),
      ),
      defineTool(
        {
          name: "secrets.refs.remove",
          version: "1.0.0",
          title: "Remove credential reference",
          description:
            "Remove one credential-source reference from Sovereign metadata. This never deletes the source secret from GitHub CLI, 1Password, or AWS.",
          category: "secrets",
          requiredCapabilities: ["secrets.write"],
          sideEffect: "write",
          destructive: true,
          permissionLevel: "consequential",
          approvalMode: "single-use",
          inputSchema: objectSchema({
            id: {
              type: "string",
              minLength: 2,
              maxLength: 64,
              pattern: "^[a-z][a-z0-9-]{1,63}$",
            },
          }),
        },
        { id: credentialId },
        ({ principal }, input) =>
          audited({
            audit: options.audit,
            principalId: principal.id,
            workspaceId: options.workspaceId,
            toolName: "secrets.refs.remove",
            operation: "remove_credential_reference",
            details: { credentialId: input.id },
            execute: () => options.credentialReferences.remove(input.id),
            successDetails: (value) => ({ removed: value.removed }),
          }),
      ),
      defineTool(
        {
          name: "sandbox.capabilities",
          version: "1.0.0",
          title: "Sandbox capabilities",
          description:
            "Probe the reviewed Docker Sandboxes executable, exact version and SHA-256 trust, authentication, and enforced Sovereign isolation profile.",
          category: "sandbox",
          requiredCapabilities: ["sandbox.read"],
          sideEffect: "process",
          destructive: false,
          permissionLevel: "observe",
          approvalMode: "none",
          inputSchema: objectSchema({
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          }),
        },
        { workspaceId },
        () => options.sandboxes.capabilities(),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "sandbox.list",
          version: "1.0.0",
          title: "List managed sandboxes",
          description:
            "List only Docker microVM sandboxes created by Sovereign for the active workspace. Unmanaged user sandboxes are never exposed or controlled.",
          category: "sandbox",
          requiredCapabilities: ["sandbox.read"],
          sideEffect: "process",
          destructive: false,
          permissionLevel: "observe",
          approvalMode: "none",
          inputSchema: objectSchema({
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          }),
        },
        { workspaceId },
        () => options.sandboxes.list(),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "sandbox.create",
          version: "1.0.0",
          title: "Create isolated sandbox",
          description:
            "Create a reviewed Docker microVM sandbox using mandatory private Git clone mode, a read-only host repository mount, and a per-sandbox deny-all network rule. Linked Git worktrees are rejected.",
          category: "sandbox",
          requiredCapabilities: ["sandbox.run"],
          sideEffect: "process",
          destructive: false,
          permissionLevel: "workspace",
          approvalMode: "session",
          inputSchema: objectSchema({
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            label: { type: "string", minLength: 1, maxLength: 80 },
            cpus: { type: "integer", minimum: 1, maximum: 32, default: 2 },
            memoryMiB: {
              type: "integer",
              minimum: 1_024,
              maximum: 32_768,
              default: 4_096,
            },
          }),
        },
        {
          workspaceId,
          label: z.string().min(1).max(80),
          cpus: z.number().int().min(1).max(32).optional(),
          memoryMiB: z.number().int().min(1_024).max(32_768).optional(),
        },
        ({ principal }, input) =>
          audited({
            audit: options.audit,
            principalId: principal.id,
            workspaceId: options.workspaceId,
            toolName: "sandbox.create",
            operation: "create_sandbox",
            details: {
              labelBytes: Buffer.byteLength(input.label, "utf8"),
              labelSha256: sha256(input.label),
              cpus: input.cpus ?? 2,
              memoryMiB: input.memoryMiB ?? 4_096,
              isolationMode: "clone",
              network: "deny-all",
            },
            execute: () =>
              options.sandboxes.create({
                label: input.label,
                cpus: input.cpus ?? 2,
                memoryMiB: input.memoryMiB ?? 4_096,
              }),
            successDetails: sandboxSummaryDetails,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "sandbox.exec",
          version: "1.0.0",
          title: "Execute inside sandbox",
          description:
            "Execute one bounded Bash command inside a Sovereign-owned offline microVM private clone. The host process uses argument-array spawning and never invokes a host shell.",
          category: "sandbox",
          requiredCapabilities: ["sandbox.run"],
          sideEffect: "process",
          destructive: false,
          permissionLevel: "workspace",
          approvalMode: "session",
          inputSchema: objectSchema({
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            sandboxId: { type: "string", format: "uuid" },
            command: { type: "string", minLength: 1, maxLength: 32_768 },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: 900_000,
              default: 120_000,
            },
          }),
        },
        {
          workspaceId,
          sandboxId,
          command: z.string().min(1).max(32_768),
          timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
        },
        ({ principal }, input) =>
          audited({
            audit: options.audit,
            principalId: principal.id,
            workspaceId: options.workspaceId,
            toolName: "sandbox.exec",
            operation: "execute_sandbox_command",
            details: {
              sandboxId: input.sandboxId,
              commandBytes: Buffer.byteLength(input.command, "utf8"),
              commandSha256: sha256(input.command),
              timeoutMs: input.timeoutMs ?? 120_000,
            },
            execute: () =>
              options.sandboxes.exec(
                input.sandboxId,
                input.command,
                input.timeoutMs ?? 120_000,
              ),
            successDetails: sandboxResultDetails,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "sandbox.collect",
          version: "1.0.0",
          title: "Collect committed sandbox work",
          description:
            "Fetch committed branch refs from one Sovereign-owned Docker sandbox into isolated refs/sovereign/sandboxes/* refs in the authorized host repository. This never copies arbitrary files, checks out, merges, stages, or changes the host working tree.",
          category: "sandbox",
          requiredCapabilities: ["sandbox.manage"],
          sideEffect: "write",
          destructive: false,
          permissionLevel: "workspace",
          approvalMode: "session",
          inputSchema: objectSchema({
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            sandboxId: { type: "string", format: "uuid" },
          }),
        },
        { workspaceId, sandboxId },
        ({ principal }, input) =>
          audited({
            audit: options.audit,
            principalId: principal.id,
            workspaceId: options.workspaceId,
            toolName: "sandbox.collect",
            operation: "collect_sandbox_commits",
            details: { sandboxId: input.sandboxId },
            execute: () => options.sandboxes.collect(input.sandboxId),
            successDetails: sandboxCollectionDetails,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "sandbox.stop",
          version: "1.0.0",
          title: "Stop sandbox",
          description:
            "Stop one Sovereign-owned microVM while preserving its private clone and sandbox-local state.",
          category: "sandbox",
          requiredCapabilities: ["sandbox.manage"],
          sideEffect: "process",
          destructive: false,
          permissionLevel: "workspace",
          approvalMode: "session",
          inputSchema: objectSchema({
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            sandboxId: { type: "string", format: "uuid" },
          }),
        },
        { workspaceId, sandboxId },
        ({ principal }, input) =>
          audited({
            audit: options.audit,
            principalId: principal.id,
            workspaceId: options.workspaceId,
            toolName: "sandbox.stop",
            operation: "stop_sandbox",
            details: { sandboxId: input.sandboxId },
            execute: () => options.sandboxes.stop(input.sandboxId),
            successDetails: sandboxSummaryDetails,
          }),
        (input) => input.workspaceId,
      ),
      defineTool(
        {
          name: "sandbox.remove",
          version: "1.0.0",
          title: "Remove sandbox",
          description:
            "Permanently remove one Sovereign-owned microVM and its private clone. Host repository files are never deleted or modified by this operation.",
          category: "sandbox",
          requiredCapabilities: ["sandbox.manage"],
          sideEffect: "process",
          destructive: true,
          permissionLevel: "consequential",
          approvalMode: "single-use",
          inputSchema: objectSchema({
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
            sandboxId: { type: "string", format: "uuid" },
          }),
        },
        { workspaceId, sandboxId },
        ({ principal }, input) =>
          audited({
            audit: options.audit,
            principalId: principal.id,
            workspaceId: options.workspaceId,
            toolName: "sandbox.remove",
            operation: "remove_sandbox",
            details: { sandboxId: input.sandboxId },
            execute: () => options.sandboxes.remove(input.sandboxId),
            successDetails: (value) => ({ removed: value.removed }),
          }),
        (input) => input.workspaceId,
      ),
    ],
  };
}
