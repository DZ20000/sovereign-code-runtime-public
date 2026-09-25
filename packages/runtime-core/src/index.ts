import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export * from "./runs.js";
export * from "./gateway-session-policy.js";

// Replaced by the Runtime Host bundler, so hot-updated hosts report their own source.
declare const __SCR_RUNTIME_BUILD_SOURCE__: { readonly commit: string; readonly dirty: boolean };
export const RUNTIME_BUILD_SOURCE = typeof __SCR_RUNTIME_BUILD_SOURCE__ === "undefined"
  ? null : __SCR_RUNTIME_BUILD_SOURCE__;

export const CHAT_SOVEREIGN_SESSION_AFFINITY = [
  "Session affinity: CHAT_SOVEREIGN.",
  "When @Sovereign is available, continue in the current Chat and use @Sovereign for computer and workspace actions.",
  "Do not treat workspace switching as a prerequisite for the task; task-specific workspace customization may not be available.",
  "If the task names an explicit path, use the currently exposed and authorized @Sovereign capabilities directly when policy allows; if a contained file or Git tool rejects that path and an authorized Terminal capability is available, prefer the narrowest read-only command against the explicit path rather than asking the user to switch workspace, and never broaden scope beyond the user's path.",
  "Do not suggest, require, or redirect the user to Work mode unless the user explicitly asks for Work.",
].join(" ");

export const CAPABILITIES = [
  "system.read",
  "system.notify",
  "workspace.read",
  "files.read",
  "files.write",
  "files.destructive",
  "search.read",
  "secrets.read",
  "secrets.write",
  "sandbox.read",
  "sandbox.run",
  "sandbox.manage",
  "git.read",
  "git.write",
  "python.run",
  "runs.read",
  "runs.cancel",
  "tasks.read",
  "tasks.write",
  "validation.run",
  "terminal.observe",
  "terminal.run",
  "browser.observe",
  "browser.control",
  "network.access",
  "workflow.run",
  "subagent.run",
  "computer.observe",
  "computer.control",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface Principal {
  readonly id: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly workspaceIds: ReadonlySet<string>;
}

export function createPrincipal(
  id: string,
  capabilities: Iterable<Capability>,
  workspaceIds: Iterable<string>,
): Principal {
  if (id.trim().length === 0) {
    throw new RuntimeError(
      "INVALID_PRINCIPAL",
      "Principal id must not be empty.",
      500,
    );
  }

  return {
    id,
    capabilities: new Set(capabilities),
    workspaceIds: new Set(workspaceIds),
  };
}

export type RuntimeErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "HOST_DENIED"
  | "ORIGIN_DENIED"
  | "INVALID_PRINCIPAL"
  | "POLICY_DENIED"
  | "WORKSPACE_NOT_FOUND"
  | "PATH_REJECTED"
  | "PATH_ESCAPE"
  | "PATH_SYMLINK"
  | "PATH_NOT_FOUND"
  | "PATH_NOT_DIRECTORY"
  | "PATH_CHANGED"
  | "FILE_EXISTS"
  | "FILE_LINKED"
  | "FILE_NOT_REGULAR"
  | "FILE_TOO_LARGE"
  | "INVALID_HASH"
  | "STALE_HASH"
  | "TOOL_NOT_FOUND"
  | "INVALID_INPUT"
  | "PROCESS_FAILED"
  | "PROCESS_TIMEOUT"
  | "PYTHON_UNAVAILABLE"
  | "RUN_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "INTERNAL_ERROR";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    status = 400,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface PublicRuntimeError {
  readonly code: RuntimeErrorCode;
  readonly message: string;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function toPublicRuntimeError(error: unknown): PublicRuntimeError {
  if (error instanceof RuntimeError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "An internal runtime error occurred.",
    status: 500,
  };
}

export class PolicyEngine {
  require(
    principal: Principal,
    requiredCapabilities: readonly Capability[],
    workspaceId?: string,
  ): void {
    if (
      workspaceId !== undefined &&
      !principal.workspaceIds.has("*") &&
      !principal.workspaceIds.has(workspaceId)
    ) {
      throw new RuntimeError(
        "POLICY_DENIED",
        `Principal ${principal.id} is not authorized for workspace ${workspaceId}.`,
        403,
        { workspaceId },
      );
    }

    for (const capability of requiredCapabilities) {
      if (!principal.capabilities.has(capability)) {
        throw new RuntimeError(
          "POLICY_DENIED",
          `Capability ${capability} is required.`,
          403,
          { capability },
        );
      }
    }
  }
}

export type ToolCategory =
  | "system"
  | "workspace"
  | "files"
  | "search"
  | "secrets"
  | "sandbox"
  | "code"
  | "git"
  | "python"
  | "runs"
  | "tasks"
  | "validation"
  | "terminal"
  | "browser"
  | "workflow"
  | "subagent"
  | "computer";

export type ToolSideEffect = "read" | "write" | "process";
export type ToolPermissionLevel = "observe" | "workspace" | "consequential";
export type RuntimePermissionProfile = ToolPermissionLevel | "bypass";
export type ToolApprovalMode = "none" | "session" | "single-use";

const PERMISSION_RANK: Readonly<Record<RuntimePermissionProfile, number>> = {
  observe: 1,
  workspace: 2,
  consequential: 3,
  bypass: 4,
};

export function permissionProfileAllows(
  profile: RuntimePermissionProfile,
  requiredLevel: ToolPermissionLevel,
): boolean {
  return PERMISSION_RANK[profile] >= PERMISSION_RANK[requiredLevel];
}

export interface ToolSpec {
  readonly name: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly requiredCapabilities: readonly Capability[];
  readonly sideEffect: ToolSideEffect;
  readonly destructive: boolean;
  readonly permissionLevel: ToolPermissionLevel;
  readonly approvalMode: ToolApprovalMode;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ToolManifest {
  readonly schemaVersion: "scr.tools/v1";
  readonly runtimeVersion: string;
  readonly generatedAt: string;
  readonly digest: string;
  readonly tools: readonly ToolSpec[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)] as const);
    return Object.fromEntries(entries);
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function equalSha256(left: string, right: string): boolean {
  if (!isSha256(left) || !isSha256(right)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function assertSha256(value: string): void {
  if (!isSha256(value)) {
    throw new RuntimeError(
      "INVALID_HASH",
      "expectedSha256 must be a lowercase 64-character SHA-256 digest.",
      400,
    );
  }
}

export function buildToolManifest(
  runtimeVersion: string,
  toolSpecs: readonly ToolSpec[],
  generatedAt = new Date().toISOString(),
): ToolManifest {
  const tools = [...toolSpecs].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const digest = sha256(
    canonicalJson({
      schemaVersion: "scr.tools/v1",
      runtimeVersion,
      tools,
    }),
  );

  return {
    schemaVersion: "scr.tools/v1",
    runtimeVersion,
    generatedAt,
    digest,
    tools,
  };
}

export type AuditOutcome = "succeeded" | "failed" | "denied";

export interface AuditReceipt {
  readonly id: string;
  readonly occurredAt: string;
  readonly principalId: string;
  readonly toolName: string;
  readonly operation: string;
  readonly outcome: AuditOutcome;
  readonly workspaceId?: string;
  readonly relativePath?: string;
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
  readonly errorCode?: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface AuditStore {
  append(receipt: AuditReceipt): void;
  list(limit?: number): readonly AuditReceipt[];
  close?(): void;
}

export class MemoryAuditStore implements AuditStore {
  readonly #receipts: AuditReceipt[] = [];

  append(receipt: AuditReceipt): void {
    this.#receipts.push(receipt);
  }

  list(limit = 100): readonly AuditReceipt[] {
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    return this.#receipts.slice(-boundedLimit).reverse();
  }
}

interface SqliteAuditRow {
  readonly id: string;
  readonly occurred_at: string;
  readonly principal_id: string;
  readonly tool_name: string;
  readonly operation: string;
  readonly outcome: AuditOutcome;
  readonly workspace_id: string | null;
  readonly relative_path: string | null;
  readonly before_sha256: string | null;
  readonly after_sha256: string | null;
  readonly error_code: string | null;
  readonly details_json: string;
}

function parseDetails(value: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Readonly<Record<string, unknown>>;
    }
  } catch {
    // A malformed historical row must not make the audit ledger unreadable.
  }
  return {};
}

export class SqliteAuditStore implements AuditStore {
  readonly #database: DatabaseSync;
  readonly #retentionLimit: number;

  constructor(databasePath: string, retentionLimit = 10_000) {
    if (!Number.isInteger(retentionLimit) || retentionLimit < 1) {
      throw new Error("Audit retention limit must be a positive integer.");
    }
    this.#retentionLimit = retentionLimit;
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    if (databasePath !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS audit_receipts (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied')),
        workspace_id TEXT,
        relative_path TEXT,
        before_sha256 TEXT,
        after_sha256 TEXT,
        error_code TEXT,
        details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_receipts_occurred_at_idx
        ON audit_receipts (occurred_at DESC);
      CREATE INDEX IF NOT EXISTS audit_receipts_principal_idx
        ON audit_receipts (principal_id, occurred_at DESC);
    `);
  }

  append(receipt: AuditReceipt): void {
    this.#database
      .prepare(
        `
        INSERT INTO audit_receipts (
          id,
          occurred_at,
          principal_id,
          tool_name,
          operation,
          outcome,
          workspace_id,
          relative_path,
          before_sha256,
          after_sha256,
          error_code,
          details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        receipt.id,
        receipt.occurredAt,
        receipt.principalId,
        receipt.toolName,
        receipt.operation,
        receipt.outcome,
        receipt.workspaceId ?? null,
        receipt.relativePath ?? null,
        receipt.beforeSha256 ?? null,
        receipt.afterSha256 ?? null,
        receipt.errorCode ?? null,
        JSON.stringify(receipt.details),
      );
    this.#database
      .prepare(
        `
        DELETE FROM audit_receipts
        WHERE id IN (
          SELECT id FROM audit_receipts
          ORDER BY occurred_at DESC
          LIMIT -1 OFFSET ?
        )
      `,
      )
      .run(this.#retentionLimit);
  }

  list(limit = 100): readonly AuditReceipt[] {
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    const rows = this.#database
      .prepare(
        `
        SELECT
          id,
          occurred_at,
          principal_id,
          tool_name,
          operation,
          outcome,
          workspace_id,
          relative_path,
          before_sha256,
          after_sha256,
          error_code,
          details_json
        FROM audit_receipts
        ORDER BY occurred_at DESC
        LIMIT ?
      `,
      )
      .all(boundedLimit) as unknown as SqliteAuditRow[];

    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      principalId: row.principal_id,
      toolName: row.tool_name,
      operation: row.operation,
      outcome: row.outcome,
      details: parseDetails(row.details_json),
      ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
      ...(row.relative_path === null
        ? {}
        : { relativePath: row.relative_path }),
      ...(row.before_sha256 === null
        ? {}
        : { beforeSha256: row.before_sha256 }),
      ...(row.after_sha256 === null ? {} : { afterSha256: row.after_sha256 }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    }));
  }

  close(): void {
    this.#database.close();
  }
}
